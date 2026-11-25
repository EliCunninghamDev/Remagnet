use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use reqwest::{header::CONTENT_TYPE, StatusCode};
use tokio::sync::RwLock;

use crate::{
    backend::{
        build_http_client, extract_magnet_hashes, primary_label, AddTorrentResult, ArchiveFile,
        ArchiveTorrent, BackendHealth, ClientKind, FileByteStream, TorrentCapabilities,
        TorrentFilePayload, TorrentSummary, VolumeMapper,
    },
    config::Config,
    error::AppError,
    xmlrpc::{encode_call, parse_response, ParseError, Value as XmlValue},
};

/// RFC 3986 unreserved characters are left unescaped in ruTorrent `d.custom1`
/// labels; everything else (spaces, quotes, semicolons, etc.) is percent-encoded
/// so it matches ruTorrent's convention and cannot inject rTorrent commands.
const LABEL_ENCODE_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

/// rTorrent's XML-RPC fault code for a missing info hash.
const FAULT_INFO_HASH_NOT_FOUND: i64 = -501;

const TORRENT_METHODS: &[&str] = &[
    "d.hash",
    "d.name",
    "d.state",
    "d.is_open",
    "d.is_active",
    "d.complete",
    "d.hashing",
    "d.is_meta",
    "d.size_bytes",
    "d.completed_bytes",
    "d.left_bytes",
    "d.down.rate",
    "d.up.rate",
    "d.ratio",
    "d.custom1",
    "d.peers_complete",
    "d.peers_accounted",
    "d.message",
    "d.custom=addtime",
    "d.timestamp.started",
    "d.creation_date",
    "d.directory",
    "d.is_multi_file",
];

/// Minimal rTorrent / ruTorrent XML-RPC client.
///
/// Works against both direct rTorrent HTTP-SCGI proxies (`/RPC2`, such as
/// `crazymax/rtorrent-rutorrent`) and ruTorrent's RPC plugin
/// (`/plugins/rpc/rpc.php`). HTTP Basic Auth is optional.
#[derive(Clone)]
pub struct RtorrentClient {
    candidates: Vec<String>,
    active_url: Arc<RwLock<Option<String>>>,
    auth: Option<(String, String)>,
    http: reqwest::Client,
    volume: VolumeMapper,
}

#[derive(Debug)]
enum RpcFailure {
    App(AppError),
    Fault { code: i64, message: String },
}

impl RpcFailure {
    fn into_app_error(self, method: &str) -> AppError {
        match self {
            Self::App(error) => error,
            Self::Fault { message, .. } => AppError::Upstream(format!(
                "rTorrent returned an error for {method}: {message}"
            )),
        }
    }
}

impl RtorrentClient {
    pub fn new(config: &Config) -> anyhow::Result<Self> {
        let http = build_http_client("rTorrent", false)?;

        let auth = (!config.username.is_empty() || !config.password.is_empty())
            .then(|| (config.username.clone(), config.password.clone()));

        Ok(Self {
            candidates: endpoint_candidates(&config.base_url),
            active_url: Arc::new(RwLock::new(None)),
            auth,
            http,
            volume: VolumeMapper::from_config(config),
        })
    }

    pub async fn test_connection(&self) -> Result<BackendHealth, AppError> {
        let app_version = self
            .rpc("system.client_version", &[])
            .await?
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_string();

        let web_api_version = match self.rpc_raw("system.library_version", &[]).await {
            Ok(value) => value.as_str().unwrap_or_default().trim().to_string(),
            Err(RpcFailure::Fault { .. }) => String::new(),
            Err(other) => return Err(other.into_app_error("system.library_version")),
        };

        Ok(BackendHealth {
            client_label: ClientKind::Rtorrent.label().to_string(),
            app_version,
            web_api_version,
            capabilities: TorrentCapabilities {
                pause_on_add: true,
                archive_download: self.volume.is_configured(),
                categories: true,
                tags: false,
                torrent_files: true,
            },
        })
    }

    pub async fn list_torrents(&self) -> Result<Vec<TorrentSummary>, AppError> {
        let mut params = Vec::with_capacity(TORRENT_METHODS.len() + 2);
        params.push(XmlValue::String(String::new()));
        params.push(XmlValue::String("main".to_string()));
        for method in TORRENT_METHODS {
            let cmd = if method.contains('=') {
                (*method).to_string()
            } else {
                format!("{method}=")
            };
            params.push(XmlValue::String(cmd));
        }

        let response = self.rpc("d.multicall2", &params).await?;
        let rows = response
            .as_array()
            .ok_or_else(|| AppError::upstream_unreadable("rTorrent"))?;

        let mut torrents = Vec::with_capacity(rows.len());
        for row in rows {
            if let Some(fields) = row.as_array() {
                if let Some(raw) = RawTorrent::from_row(fields) {
                    torrents.push(raw);
                }
            }
        }

        // Match qBittorrent, Transmission, and Deluge: newest additions first.
        torrents.sort_by_key(|torrent| std::cmp::Reverse(torrent.added_at));
        Ok(torrents.iter().map(RawTorrent::summary).collect())
    }

    /// Fetch a torrent without applying the proxy's category/tag filter.
    pub async fn get_torrent(&self, hash: &str) -> Result<Option<TorrentSummary>, AppError> {
        Ok(self
            .fetch_single_torrent(hash)
            .await?
            .map(|torrent| torrent.summary()))
    }

    pub async fn add_torrent(
        &self,
        urls: &[String],
        files: &[TorrentFilePayload],
        category: &str,
        tags: &[String],
        paused: bool,
    ) -> Result<AddTorrentResult, AppError> {
        if urls.is_empty() && files.is_empty() {
            return Err(AppError::BadRequest(
                "No magnet, torrent URL, or .torrent file was supplied.".to_string(),
            ));
        }

        let label = primary_label(category, tags);

        // rTorrent's `load.*` methods can silently return 0 when an info hash
        // already exists, so check known hashes upfront to report duplicates
        // consistently as 400 Bad Request.
        let mut seen_hashes = HashSet::new();
        for hash in extract_magnet_hashes(urls)
            .into_iter()
            .chain(files.iter().map(|file| file.info_hash.clone()))
        {
            if !seen_hashes.insert(hash.clone()) {
                return Err(AppError::BadRequest(
                    "rTorrent already has this torrent.".to_string(),
                ));
            }
            if self.fetch_single_torrent(&hash).await?.is_some() {
                return Err(AppError::BadRequest(
                    "rTorrent already has this torrent.".to_string(),
                ));
            }
        }

        let now = crate::auth::now_secs();
        let mut post_commands = vec![format!("d.custom.set=addtime,{now}")];
        if !label.is_empty() {
            post_commands.push(format!("d.custom1.set={}", encode_label(label)));
        }

        let url_method = if paused { "load.normal" } else { "load.start" };
        let raw_method = if paused { "load.raw" } else { "load.raw_start" };

        let mut hashes = Vec::new();
        for url in urls {
            self.load_torrent(
                url_method,
                XmlValue::String(url.trim().to_string()),
                &post_commands,
            )
            .await?;
            hashes.extend(extract_magnet_hashes(std::slice::from_ref(url)));
        }

        for file in files {
            self.load_torrent(
                raw_method,
                XmlValue::Base64(file.bytes.clone()),
                &post_commands,
            )
            .await?;
            hashes.push(file.info_hash.clone());
        }

        Ok(AddTorrentResult {
            added: urls.len() + files.len(),
            hashes,
            category: label.to_string(),
            tags: Vec::new(),
        })
    }

    pub async fn remove_torrent(&self, hash: &str, delete_files: bool) -> Result<(), AppError> {
        let target = hash.to_ascii_uppercase();

        if delete_files {
            // Standard ruTorrent/rTorrent erasedata hook convention: setting
            // custom5=1 signals `event.download.erased` handlers to delete the
            // payload, and `d.delete_tied` removes any watched `.torrent` file.
            // A missing method surfaces as an XML-RPC fault, which is safe to
            // ignore; auth and network failures must still propagate.
            self.rpc_ignoring_fault(
                "d.custom5.set",
                &[
                    XmlValue::String(target.clone()),
                    XmlValue::String("1".to_string()),
                ],
            )
            .await?;
            self.rpc_ignoring_fault("d.delete_tied", &[XmlValue::String(target.clone())])
                .await?;
        }

        match self.rpc_raw("d.erase", &[XmlValue::String(target)]).await {
            Ok(_) => Ok(()),
            Err(RpcFailure::Fault { code, message }) if is_not_found_fault(code, &message) => Err(
                AppError::NotFound("Torrent not found in rTorrent.".to_string()),
            ),
            Err(other) => Err(other.into_app_error("d.erase")),
        }
    }

    pub async fn archive_torrent(&self, hash: &str) -> Result<ArchiveTorrent, AppError> {
        let torrent = self
            .fetch_single_torrent(hash)
            .await?
            .ok_or_else(|| AppError::NotFound("Torrent not found.".to_string()))?;

        let download_dir = archive_download_dir(&torrent.directory, torrent.is_multi_file);
        let progress = torrent.progress();
        let state = torrent.state();

        Ok(ArchiveTorrent {
            hash: torrent.hash,
            name: torrent.name,
            progress,
            amount_left: torrent.left_bytes,
            state,
            category: torrent.label,
            tags: Vec::new(),
            download_dir,
        })
    }

    pub async fn files(&self, hash: &str) -> Result<Vec<ArchiveFile>, AppError> {
        let torrent = self
            .fetch_single_torrent(hash)
            .await?
            .ok_or_else(|| AppError::NotFound("Torrent not found.".to_string()))?;

        let target = hash.to_ascii_uppercase();
        let params = [
            XmlValue::String(target),
            XmlValue::String(String::new()),
            XmlValue::String("f.path=".to_string()),
            XmlValue::String("f.size_bytes=".to_string()),
            XmlValue::String("f.completed_chunks=".to_string()),
            XmlValue::String("f.size_chunks=".to_string()),
            XmlValue::String("f.priority=".to_string()),
        ];

        let response = match self.rpc_raw("f.multicall", &params).await {
            Ok(value) => value,
            Err(RpcFailure::Fault { code, message }) if is_not_found_fault(code, &message) => {
                return Err(AppError::NotFound("Torrent not found.".to_string()));
            }
            Err(other) => return Err(other.into_app_error("f.multicall")),
        };

        let rows = response
            .as_array()
            .ok_or_else(|| AppError::upstream_unreadable("rTorrent"))?;

        let folder_prefix = if torrent.is_multi_file {
            split_directory(&torrent.directory).1
        } else {
            None
        };

        let mut files = Vec::with_capacity(rows.len());
        for (index, row) in rows.iter().enumerate() {
            let Some(fields) = row.as_array() else {
                continue;
            };
            let path = fields
                .first()
                .and_then(XmlValue::as_str)
                .unwrap_or_default()
                .trim();
            if path.is_empty() {
                continue;
            }
            let size = fields.get(1).and_then(XmlValue::as_u64).unwrap_or(0);
            let completed_chunks = fields.get(2).and_then(XmlValue::as_u64).unwrap_or(0);
            let size_chunks = fields.get(3).and_then(XmlValue::as_u64).unwrap_or(0);
            let priority = fields.get(4).and_then(XmlValue::as_i64).unwrap_or(1);

            if priority == 0 {
                continue;
            }

            let name = match folder_prefix.as_deref() {
                Some(folder) => {
                    let normalized = path.replace('\\', "/");
                    let trimmed = normalized.trim_start_matches('/');
                    if trimmed.starts_with(&format!("{folder}/")) {
                        trimmed.to_string()
                    } else {
                        format!("{folder}/{trimmed}")
                    }
                }
                None => path.to_string(),
            };

            let progress = if size == 0 || size_chunks == 0 {
                if torrent.complete {
                    1.0
                } else {
                    0.0
                }
            } else {
                (completed_chunks as f64 / size_chunks as f64).clamp(0.0, 1.0)
            };

            files.push(ArchiveFile {
                index: index as i64,
                name,
                size,
                progress,
            });
        }

        Ok(files)
    }

    /// Stream one torrent file from the mounted downloads volume.
    pub async fn open_file(
        &self,
        torrent: &ArchiveTorrent,
        file: &ArchiveFile,
    ) -> Result<FileByteStream, AppError> {
        self.volume
            .open_file(torrent.download_dir.as_deref(), &file.name)
            .await
    }

    async fn fetch_single_torrent(&self, hash: &str) -> Result<Option<RawTorrent>, AppError> {
        let target = hash.to_ascii_uppercase();
        let calls: Vec<XmlValue> = TORRENT_METHODS
            .iter()
            .map(|entry| {
                let (method, params) = if let Some((method, arg)) = entry.split_once('=') {
                    (
                        method,
                        vec![
                            XmlValue::String(target.clone()),
                            XmlValue::String(arg.to_string()),
                        ],
                    )
                } else {
                    (*entry, vec![XmlValue::String(target.clone())])
                };
                let mut map = HashMap::new();
                map.insert(
                    "methodName".to_string(),
                    XmlValue::String(method.to_string()),
                );
                map.insert("params".to_string(), XmlValue::Array(params));
                XmlValue::Struct(map)
            })
            .collect();

        let response = self
            .rpc("system.multicall", &[XmlValue::Array(calls)])
            .await?;
        let results = response
            .as_array()
            .ok_or_else(|| AppError::upstream_unreadable("rTorrent"))?;

        if results.len() != TORRENT_METHODS.len() {
            return Err(AppError::Upstream(
                "rTorrent returned an unexpected multicall response.".to_string(),
            ));
        }

        let mut row = Vec::with_capacity(results.len());
        for (index, item) in results.iter().enumerate() {
            match item {
                XmlValue::Array(values) if !values.is_empty() => {
                    row.push(values[0].clone());
                }
                XmlValue::Struct(fault) => {
                    let code = fault
                        .get("faultCode")
                        .and_then(XmlValue::as_i64)
                        .unwrap_or(0);
                    let message = fault
                        .get("faultString")
                        .and_then(XmlValue::as_str)
                        .unwrap_or("unknown fault");
                    if is_not_found_fault(code, message) {
                        return Ok(None);
                    }
                    // `d.custom=addtime` may not exist on minimal setups; only
                    // treat a missing info-hash as None, otherwise propagate.
                    if TORRENT_METHODS[index] == "d.custom=addtime" {
                        row.push(XmlValue::String(String::new()));
                    } else {
                        return Err(AppError::Upstream(format!(
                            "rTorrent returned an error for {}: {message}",
                            TORRENT_METHODS[index]
                        )));
                    }
                }
                _ => row.push(XmlValue::String(String::new())),
            }
        }

        Ok(RawTorrent::from_row(&row))
    }

    /// Build an XML-RPC POST with the endpoint's optional Basic Auth applied.
    fn request(&self, url: &str, body: &str) -> reqwest::RequestBuilder {
        let request = self
            .http
            .post(url)
            .header(CONTENT_TYPE, "text/xml; charset=utf-8")
            .body(body.to_string());
        match &self.auth {
            Some((username, password)) => request.basic_auth(username, Some(password)),
            None => request,
        }
    }

    async fn load_torrent(
        &self,
        method: &str,
        payload: XmlValue,
        post_commands: &[String],
    ) -> Result<(), AppError> {
        let mut params = Vec::with_capacity(2 + post_commands.len());
        params.push(XmlValue::String(String::new()));
        params.push(payload);
        params.extend(post_commands.iter().cloned().map(XmlValue::String));
        self.rpc_raw(method, &params)
            .await
            .map_err(|failure| map_load_failure(failure, method))?;
        Ok(())
    }

    async fn rpc_ignoring_fault(&self, method: &str, params: &[XmlValue]) -> Result<(), AppError> {
        match self.rpc_raw(method, params).await {
            Ok(_) => Ok(()),
            Err(RpcFailure::Fault { .. }) => Ok(()),
            Err(other) => Err(other.into_app_error(method)),
        }
    }

    async fn rpc(&self, method: &str, params: &[XmlValue]) -> Result<XmlValue, AppError> {
        self.rpc_raw(method, params)
            .await
            .map_err(|failure| failure.into_app_error(method))
    }

    async fn rpc_raw(&self, method: &str, params: &[XmlValue]) -> Result<XmlValue, RpcFailure> {
        let body = encode_call(method, params);

        if let Some(url) = self.active_url.read().await.clone() {
            return self.send_xml(&url, method, &body).await;
        }

        let last_index = self.candidates.len().saturating_sub(1);
        for (index, candidate) in self.candidates.iter().enumerate() {
            let response = self
                .request(candidate, &body)
                .send()
                .await
                .map_err(|error| RpcFailure::App(AppError::from_reqwest("rTorrent", error)))?;

            let status = response.status();
            if index < last_index
                && matches!(
                    status,
                    StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED
                )
            {
                continue;
            }

            // Only pin an endpoint that actually works: a 5xx or unexpected
            // 404 from the final candidate must not poison every later call.
            if status.is_success()
                || matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN)
            {
                *self.active_url.write().await = Some(candidate.clone());
            }
            return parse_http_response(response, method).await;
        }

        unreachable!("candidates is always non-empty")
    }

    async fn send_xml(&self, url: &str, method: &str, body: &str) -> Result<XmlValue, RpcFailure> {
        let response = self
            .request(url, body)
            .send()
            .await
            .map_err(|error| RpcFailure::App(AppError::from_reqwest("rTorrent", error)))?;
        parse_http_response(response, method).await
    }
}

async fn parse_http_response(
    response: reqwest::Response,
    method: &str,
) -> Result<XmlValue, RpcFailure> {
    let status = response.status();
    if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
        return Err(RpcFailure::App(AppError::UpstreamAuth(
            "rTorrent rejected the saved credentials. Update the username and password in the Remagnet Proxy page."
                .to_string(),
        )));
    }

    let text = response
        .text()
        .await
        .map_err(|error| RpcFailure::App(AppError::from_reqwest("rTorrent", error)))?;

    if !status.is_success() {
        return Err(RpcFailure::App(AppError::upstream_status(
            "rTorrent", status, method, &text,
        )));
    }

    parse_response(&text).map_err(|error| match error {
        ParseError::Fault { code, message } => RpcFailure::Fault { code, message },
        ParseError::Malformed(detail) => {
            tracing::warn!(detail = %detail, method, "could not parse rTorrent XML-RPC response");
            RpcFailure::App(AppError::upstream_unreadable("rTorrent"))
        }
    })
}

/// Resolve the ordered XML-RPC endpoints to try for a configured base URL.
///
/// Explicit RPC paths (`/RPC2`, `*.php`, `/xmlrpc`, `/scgi`) are used verbatim.
/// Bare origins or ruTorrent base paths try `/RPC2` first and fall back to
/// ruTorrent's `/plugins/rpc/rpc.php`.
fn endpoint_candidates(base_url: &str) -> Vec<String> {
    let base_url = base_url.trim().trim_end_matches('/');
    let lower = base_url.to_ascii_lowercase();
    if lower.ends_with("/rpc2")
        || lower.ends_with(".php")
        || lower.ends_with("/xmlrpc")
        || lower.ends_with("/scgi")
    {
        vec![base_url.to_string()]
    } else {
        vec![
            format!("{base_url}/RPC2"),
            format!("{base_url}/plugins/rpc/rpc.php"),
        ]
    }
}

fn encode_label(label: &str) -> String {
    utf8_percent_encode(label.trim(), LABEL_ENCODE_SET).to_string()
}

fn decode_label(raw: &str) -> String {
    percent_decode_str(raw.trim())
        .decode_utf8_lossy()
        .trim()
        .to_string()
}

fn is_not_found_fault(code: i64, message: &str) -> bool {
    code == FAULT_INFO_HASH_NOT_FOUND
        || message
            .to_ascii_lowercase()
            .contains("could not find info-hash")
}

fn map_load_failure(failure: RpcFailure, method: &str) -> AppError {
    match failure {
        RpcFailure::Fault { message, .. } => {
            let lower = message.to_ascii_lowercase();
            if lower.contains("already") || lower.contains("duplicate") {
                AppError::BadRequest("rTorrent already has this torrent.".to_string())
            } else if lower.contains("could not") || lower.contains("invalid") {
                AppError::BadRequest(format!("rTorrent rejected the torrent: {message}"))
            } else {
                AppError::Upstream(format!(
                    "rTorrent returned an error for {method}: {message}"
                ))
            }
        }
        other => other.into_app_error(method),
    }
}

/// Split an rTorrent multi-file `d.directory` (`/downloads/Album`) into its
/// parent directory (`/downloads`) and top-level folder (`Album`).
fn split_directory(dir: &str) -> (Option<String>, Option<String>) {
    let normalized = dir.trim().replace('\\', "/");
    let trimmed = normalized.trim_end_matches('/');
    if trimmed.is_empty() {
        return (None, None);
    }

    match trimmed.rsplit_once('/') {
        Some(("", folder)) if !folder.is_empty() => {
            (Some("/".to_string()), Some(folder.to_string()))
        }
        Some((parent, folder)) if !folder.is_empty() => {
            (Some(parent.to_string()), Some(folder.to_string()))
        }
        _ => (Some(trimmed.to_string()), None),
    }
}

fn archive_download_dir(directory: &str, is_multi_file: bool) -> Option<String> {
    let trimmed = directory.trim();
    if trimmed.is_empty() {
        return None;
    }
    if is_multi_file {
        split_directory(trimmed).0
    } else {
        Some(trimmed.to_string())
    }
}

#[derive(Debug, Clone)]
struct RawTorrent {
    hash: String,
    name: String,
    state_flag: i64,
    is_open: bool,
    is_active: bool,
    complete: bool,
    hashing: i64,
    is_meta: bool,
    size_bytes: u64,
    completed_bytes: u64,
    left_bytes: u64,
    down_rate: u64,
    up_rate: u64,
    ratio_milli: i64,
    label: String,
    seeds: u64,
    peers: u64,
    message: String,
    added_at: i64,
    directory: String,
    is_multi_file: bool,
}

impl RawTorrent {
    fn from_row(fields: &[XmlValue]) -> Option<Self> {
        let hash = fields.first()?.as_str()?.trim().to_ascii_lowercase();
        if hash.is_empty() {
            return None;
        }
        let name = fields
            .get(1)
            .and_then(XmlValue::as_str)
            .unwrap_or_default()
            .to_string();
        let state_flag = fields.get(2).and_then(XmlValue::as_i64).unwrap_or(0);
        let is_open = fields.get(3).and_then(XmlValue::as_i64).unwrap_or(0) != 0;
        let is_active = fields.get(4).and_then(XmlValue::as_i64).unwrap_or(0) != 0;
        let complete = fields.get(5).and_then(XmlValue::as_i64).unwrap_or(0) != 0;
        let hashing = fields.get(6).and_then(XmlValue::as_i64).unwrap_or(0);
        let is_meta = fields.get(7).and_then(XmlValue::as_i64).unwrap_or(0) != 0;
        let size_bytes = fields.get(8).and_then(XmlValue::as_u64).unwrap_or(0);
        let completed_bytes = fields.get(9).and_then(XmlValue::as_u64).unwrap_or(0);
        let left_bytes = fields.get(10).and_then(XmlValue::as_u64).unwrap_or(0);
        let down_rate = fields.get(11).and_then(XmlValue::as_u64).unwrap_or(0);
        let up_rate = fields.get(12).and_then(XmlValue::as_u64).unwrap_or(0);
        let ratio_milli = fields.get(13).and_then(XmlValue::as_i64).unwrap_or(0);
        let label = decode_label(
            fields
                .get(14)
                .and_then(XmlValue::as_str)
                .unwrap_or_default(),
        );
        let seeds = fields.get(15).and_then(XmlValue::as_u64).unwrap_or(0);
        let peers = fields.get(16).and_then(XmlValue::as_u64).unwrap_or(0);
        let message = fields
            .get(17)
            .and_then(XmlValue::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let addtime = fields
            .get(18)
            .and_then(XmlValue::as_str)
            .and_then(|value| value.trim().parse::<i64>().ok())
            .filter(|value| *value > 0);
        let started = fields
            .get(19)
            .and_then(XmlValue::as_i64)
            .filter(|value| *value > 0);
        let created = fields.get(20).and_then(XmlValue::as_i64).unwrap_or(0);
        let added_at = addtime.or(started).unwrap_or(created);
        let directory = fields
            .get(21)
            .and_then(XmlValue::as_str)
            .unwrap_or_default()
            .to_string();
        let is_multi_file = fields.get(22).and_then(XmlValue::as_i64).unwrap_or(0) != 0;

        Some(Self {
            hash,
            name,
            state_flag,
            is_open,
            is_active,
            complete,
            hashing,
            is_meta,
            size_bytes,
            completed_bytes,
            left_bytes,
            down_rate,
            up_rate,
            ratio_milli,
            label,
            seeds,
            peers,
            message,
            added_at,
            directory,
            is_multi_file,
        })
    }

    fn progress(&self) -> f64 {
        if self.complete {
            1.0
        } else if self.size_bytes == 0 {
            0.0
        } else {
            (self.completed_bytes as f64 / self.size_bytes as f64).clamp(0.0, 1.0)
        }
    }

    fn state(&self) -> String {
        if self.hashing != 0 {
            return "checking".to_string();
        }
        if !self.message.is_empty()
            && !self.message.to_ascii_lowercase().starts_with("tracker:")
            && !self.complete
        {
            return "error".to_string();
        }
        if !self.is_open || !self.is_active || self.state_flag == 0 {
            return "stopped".to_string();
        }
        if self.is_meta {
            return "metadata".to_string();
        }
        if self.complete {
            return "seeding".to_string();
        }
        "downloading".to_string()
    }

    fn eta(&self) -> i64 {
        if self.complete || self.left_bytes == 0 {
            0
        } else if self.down_rate > 0 {
            self.left_bytes
                .checked_div(self.down_rate)
                .unwrap_or_default()
                .min(i64::MAX as u64) as i64
        } else {
            -1
        }
    }

    fn summary(&self) -> TorrentSummary {
        TorrentSummary {
            hash: self.hash.clone(),
            name: self.name.clone(),
            state: self.state(),
            progress: self.progress(),
            size: self.size_bytes,
            download_speed: self.down_rate,
            upload_speed: self.up_rate,
            eta: self.eta(),
            ratio: (self.ratio_milli.max(0) as f64) / 1000.0,
            category: self.label.clone(),
            tags: Vec::new(),
            seeds: self.seeds,
            peers: self.peers,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::{
        body::Body,
        extract::State,
        http::{header, Request},
        response::{IntoResponse, Response},
        Router,
    };
    use futures_lite::StreamExt;
    use http_body_util::BodyExt;

    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

    use super::*;
    use crate::xmlrpc::{encode_fault, encode_response, parse_call};

    const HASH: &str = "dc555f7a26f1acae38a18edc04e53588ade33051";

    #[derive(Clone)]
    struct FakeRtorrent {
        state: Arc<Mutex<FakeState>>,
    }

    struct FakeTorrent {
        hash: String,
        name: String,
        state_flag: i64,
        is_open: i64,
        is_active: i64,
        complete: i64,
        hashing: i64,
        is_meta: i64,
        size_bytes: i64,
        completed_bytes: i64,
        left_bytes: i64,
        down_rate: i64,
        up_rate: i64,
        ratio: i64,
        label: String,
        seeds: i64,
        peers: i64,
        message: String,
        addtime: String,
        started: i64,
        created: i64,
        directory: String,
        is_multi_file: i64,
        files: Vec<(String, i64, i64, i64, i64)>,
    }

    struct FakeState {
        endpoint: String,
        auth: Option<(String, String)>,
        client_version: String,
        library_version: String,
        torrents: Vec<FakeTorrent>,
        requests: Vec<(String, String)>,
    }

    impl FakeTorrent {
        fn sample(hash: &str, name: &str, complete: bool, addtime: &str) -> Self {
            Self {
                hash: hash.to_ascii_uppercase(),
                name: name.to_string(),
                state_flag: 1,
                is_open: 1,
                is_active: 1,
                complete: i64::from(complete),
                hashing: 0,
                is_meta: 0,
                size_bytes: 1000,
                completed_bytes: if complete { 1000 } else { 500 },
                left_bytes: if complete { 0 } else { 500 },
                down_rate: if complete { 0 } else { 250 },
                up_rate: 50,
                ratio: 1500,
                label: "remagnet".to_string(),
                seeds: 3,
                peers: 2,
                message: String::new(),
                addtime: addtime.to_string(),
                started: 100,
                created: 90,
                directory: "/downloads".to_string(),
                is_multi_file: 0,
                files: vec![("fixture.bin".to_string(), 1000, 1, 1, 1)],
            }
        }

        fn row(&self) -> XmlValue {
            XmlValue::Array(vec![
                XmlValue::String(self.hash.clone()),
                XmlValue::String(self.name.clone()),
                XmlValue::Int(self.state_flag),
                XmlValue::Int(self.is_open),
                XmlValue::Int(self.is_active),
                XmlValue::Int(self.complete),
                XmlValue::Int(self.hashing),
                XmlValue::Int(self.is_meta),
                XmlValue::Int(self.size_bytes),
                XmlValue::Int(self.completed_bytes),
                XmlValue::Int(self.left_bytes),
                XmlValue::Int(self.down_rate),
                XmlValue::Int(self.up_rate),
                XmlValue::Int(self.ratio),
                XmlValue::String(self.label.clone()),
                XmlValue::Int(self.seeds),
                XmlValue::Int(self.peers),
                XmlValue::String(self.message.clone()),
                XmlValue::String(self.addtime.clone()),
                XmlValue::Int(self.started),
                XmlValue::Int(self.created),
                XmlValue::String(self.directory.clone()),
                XmlValue::Int(self.is_multi_file),
            ])
        }

        fn field_by_method(&self, method: &str) -> XmlValue {
            match method {
                "d.hash" => XmlValue::String(self.hash.clone()),
                "d.name" => XmlValue::String(self.name.clone()),
                "d.state" => XmlValue::Int(self.state_flag),
                "d.is_open" => XmlValue::Int(self.is_open),
                "d.is_active" => XmlValue::Int(self.is_active),
                "d.complete" => XmlValue::Int(self.complete),
                "d.hashing" => XmlValue::Int(self.hashing),
                "d.is_meta" => XmlValue::Int(self.is_meta),
                "d.size_bytes" => XmlValue::Int(self.size_bytes),
                "d.completed_bytes" => XmlValue::Int(self.completed_bytes),
                "d.left_bytes" => XmlValue::Int(self.left_bytes),
                "d.down.rate" => XmlValue::Int(self.down_rate),
                "d.up.rate" => XmlValue::Int(self.up_rate),
                "d.ratio" => XmlValue::Int(self.ratio),
                "d.custom1" => XmlValue::String(self.label.clone()),
                "d.peers_complete" => XmlValue::Int(self.seeds),
                "d.peers_accounted" => XmlValue::Int(self.peers),
                "d.message" => XmlValue::String(self.message.clone()),
                "d.custom" => XmlValue::String(self.addtime.clone()),
                "d.timestamp.started" => XmlValue::Int(self.started),
                "d.creation_date" => XmlValue::Int(self.created),
                "d.directory" => XmlValue::String(self.directory.clone()),
                "d.is_multi_file" => XmlValue::Int(self.is_multi_file),
                _ => XmlValue::String(String::new()),
            }
        }
    }

    impl FakeRtorrent {
        fn new(torrents: Vec<FakeTorrent>) -> Self {
            Self {
                state: Arc::new(Mutex::new(FakeState {
                    endpoint: "/RPC2".to_string(),
                    auth: None,
                    client_version: "0.9.8".to_string(),
                    library_version: "0.13.8".to_string(),
                    torrents,
                    requests: Vec::new(),
                })),
            }
        }

        fn requests(&self) -> Vec<(String, String)> {
            self.state.lock().unwrap().requests.clone()
        }
    }

    fn xml_response(value: &XmlValue) -> Response {
        (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/xml")],
            encode_response(value),
        )
            .into_response()
    }

    fn xml_fault(code: i64, message: &str) -> Response {
        (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/xml")],
            encode_fault(code, message),
        )
            .into_response()
    }

    async fn fake_xmlrpc(State(fake): State<FakeRtorrent>, request: Request<Body>) -> Response {
        let path = request.uri().path().to_string();
        let auth_header = request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let body = String::from_utf8(
            request
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .to_vec(),
        )
        .unwrap();

        let mut state = fake.state.lock().unwrap();
        if path != state.endpoint {
            return StatusCode::NOT_FOUND.into_response();
        }
        if let Some((username, password)) = &state.auth {
            let expected = format!("Basic {}", BASE64.encode(format!("{username}:{password}")));
            if auth_header.as_deref() != Some(expected.as_str()) {
                return StatusCode::UNAUTHORIZED.into_response();
            }
        }

        let (method, params) = parse_call(&body).unwrap();
        state.requests.push((path, body.clone()));

        match method.as_str() {
            "system.client_version" => {
                xml_response(&XmlValue::String(state.client_version.clone()))
            }
            "system.library_version" => {
                xml_response(&XmlValue::String(state.library_version.clone()))
            }
            "d.multicall2" => {
                let rows = state.torrents.iter().map(FakeTorrent::row).collect();
                xml_response(&XmlValue::Array(rows))
            }
            "system.multicall" => {
                let calls = params.first().and_then(XmlValue::as_array).unwrap_or(&[]);
                let mut out = Vec::with_capacity(calls.len());
                for call in calls {
                    let XmlValue::Struct(map) = call else {
                        continue;
                    };
                    let sub_method = map
                        .get("methodName")
                        .and_then(XmlValue::as_str)
                        .unwrap_or_default();
                    let sub_params = map
                        .get("params")
                        .and_then(XmlValue::as_array)
                        .unwrap_or(&[]);
                    let hash = sub_params
                        .first()
                        .and_then(XmlValue::as_str)
                        .unwrap_or_default();
                    match state
                        .torrents
                        .iter()
                        .find(|torrent| torrent.hash.eq_ignore_ascii_case(hash))
                    {
                        Some(torrent) => {
                            out.push(XmlValue::Array(vec![torrent.field_by_method(sub_method)]));
                        }
                        None => {
                            let mut fault = HashMap::new();
                            fault.insert(
                                "faultCode".to_string(),
                                XmlValue::Int(FAULT_INFO_HASH_NOT_FOUND),
                            );
                            fault.insert(
                                "faultString".to_string(),
                                XmlValue::String("Could not find info-hash.".to_string()),
                            );
                            out.push(XmlValue::Struct(fault));
                        }
                    }
                }
                xml_response(&XmlValue::Array(out))
            }
            "f.multicall" => {
                let hash = params
                    .first()
                    .and_then(XmlValue::as_str)
                    .unwrap_or_default();
                match state
                    .torrents
                    .iter()
                    .find(|torrent| torrent.hash.eq_ignore_ascii_case(hash))
                {
                    Some(torrent) => {
                        let rows = torrent
                            .files
                            .iter()
                            .map(|(path, size, completed, total, priority)| {
                                XmlValue::Array(vec![
                                    XmlValue::String(path.clone()),
                                    XmlValue::Int(*size),
                                    XmlValue::Int(*completed),
                                    XmlValue::Int(*total),
                                    XmlValue::Int(*priority),
                                ])
                            })
                            .collect();
                        xml_response(&XmlValue::Array(rows))
                    }
                    None => xml_fault(FAULT_INFO_HASH_NOT_FOUND, "Could not find info-hash."),
                }
            }
            "load.normal" | "load.start" | "load.raw" | "load.raw_start" => {
                xml_response(&XmlValue::Int(0))
            }
            "d.custom5.set" | "d.delete_tied" | "d.erase" => {
                let hash = params
                    .first()
                    .and_then(XmlValue::as_str)
                    .unwrap_or_default();
                if state
                    .torrents
                    .iter()
                    .any(|torrent| torrent.hash.eq_ignore_ascii_case(hash))
                {
                    if method == "d.erase" {
                        state
                            .torrents
                            .retain(|torrent| !torrent.hash.eq_ignore_ascii_case(hash));
                    }
                    xml_response(&XmlValue::Int(0))
                } else {
                    xml_fault(FAULT_INFO_HASH_NOT_FOUND, "Could not find info-hash.")
                }
            }
            _ => xml_fault(-506, &format!("Method '{method}' not defined")),
        }
    }

    async fn start_fake(fake: FakeRtorrent) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().fallback(fake_xmlrpc).with_state(fake);
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{address}")
    }

    fn config(base_url: &str, downloads_dir: &str) -> Config {
        Config {
            client_kind: ClientKind::Rtorrent,
            base_url: base_url.to_string(),
            api_key: String::new(),
            username: String::new(),
            password: String::new(),
            downloads_dir: downloads_dir.to_string(),
            client_downloads_dir: "/downloads".to_string(),
            default_category: "remagnet".to_string(),
            default_tags: Vec::new(),
        }
    }

    fn sample_torrent_file() -> TorrentFilePayload {
        let info =
            b"d6:lengthi4096e4:name4:test12:piece lengthi16384e6:pieces20:01234567890123456789e";
        let mut bytes = b"d4:info".to_vec();
        bytes.extend_from_slice(info);
        bytes.push(b'e');
        let info_hash = crate::bencode::extract_info_hash(&bytes).unwrap();
        let base64 = BASE64.encode(&bytes);
        TorrentFilePayload {
            filename: "sample.torrent".to_string(),
            bytes,
            base64,
            info_hash,
        }
    }

    #[test]
    fn resolves_rpc2_and_rutorrent_plugin_candidates() {
        assert_eq!(
            endpoint_candidates("http://rtorrent:8000"),
            vec![
                "http://rtorrent:8000/RPC2",
                "http://rtorrent:8000/plugins/rpc/rpc.php"
            ]
        );
        assert_eq!(
            endpoint_candidates("http://rtorrent:8000/RPC2"),
            vec!["http://rtorrent:8000/RPC2"]
        );
        assert_eq!(
            endpoint_candidates("https://seedbox.example.com/rutorrent/plugins/rpc/rpc.php"),
            vec!["https://seedbox.example.com/rutorrent/plugins/rpc/rpc.php"]
        );
    }

    #[test]
    fn xmlrpc_round_trips_entities_ex_i8_empty_tags_and_faults() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
            <!-- comment -->
            <methodResponse>
              <params>
                <param>
                  <value>
                    <array>
                      <data>
                        <value><string>A &amp; B &lt;3&gt; &#33; &#x3F;</string></value>
                        <value><ex:i8>4294967296</ex:i8></value>
                        <value>bare string</value>
                        <value><string/></value>
                        <value/>
                        <value><boolean>1</boolean></value>
                      </data>
                    </array>
                  </value>
                </param>
              </params>
            </methodResponse>"#;

        let parsed = parse_response(xml).unwrap();
        let items = parsed.as_array().unwrap();
        assert_eq!(items[0].as_str(), Some("A & B <3> ! ?"));
        assert_eq!(items[1].as_i64(), Some(4_294_967_296));
        assert_eq!(items[2].as_str(), Some("bare string"));
        assert_eq!(items[3].as_str(), Some(""));
        assert_eq!(items[4].as_str(), Some(""));
        assert_eq!(items[5].as_i64(), Some(1));

        let fault_xml = r#"<methodResponse><fault><value><struct>
            <member><name>faultCode</name><value><i4>-501</i4></value></member>
            <member><name>faultString</name><value><string>Could not find info-hash.</string></value></member>
        </struct></value></fault></methodResponse>"#;
        assert_eq!(
            parse_response(fault_xml),
            Err(ParseError::Fault {
                code: -501,
                message: "Could not find info-hash.".to_string(),
            })
        );
    }

    #[tokio::test]
    async fn falls_back_to_rutorrent_rpc_php_and_sends_basic_auth() {
        let fake = FakeRtorrent::new(Vec::new());
        {
            let mut state = fake.state.lock().unwrap();
            state.endpoint = "/plugins/rpc/rpc.php".to_string();
            state.auth = Some(("admin".to_string(), "secret".to_string()));
        }
        let base_url = start_fake(fake.clone()).await;

        let mut cfg = config(&base_url, "");
        cfg.username = "admin".to_string();
        cfg.password = "secret".to_string();
        let client = RtorrentClient::new(&cfg).unwrap();

        let health = client.test_connection().await.unwrap();
        assert_eq!(health.client_label, "rTorrent");
        assert_eq!(health.app_version, "0.9.8");
        assert_eq!(health.web_api_version, "0.13.8");
        assert!(health.capabilities.categories);
        assert!(!health.capabilities.tags);
        assert!(!health.capabilities.archive_download);

        let paths: Vec<String> = fake.requests().into_iter().map(|(p, _)| p).collect();
        assert!(paths.iter().all(|path| path == "/plugins/rpc/rpc.php"));
    }

    #[tokio::test]
    async fn lists_torrents_normalized_newest_first_and_decodes_rutorrent_labels() {
        let mut older = FakeTorrent::sample(&"1".repeat(40), "Older", false, "1000");
        older.is_active = 0;
        older.state_flag = 0;
        older.label = "my%20label".to_string();

        let mut newer = FakeTorrent::sample(&"2".repeat(40), "Newer", true, "2000");
        newer.message = "Tracker: [Tried all trackers.]".to_string();

        let mut meta = FakeTorrent::sample(&"3".repeat(40), "MagnetMeta", false, "1500");
        meta.is_meta = 1;
        meta.size_bytes = 0;
        meta.completed_bytes = 0;
        meta.left_bytes = 0;

        let fake = FakeRtorrent::new(vec![older, newer, meta]);
        let base_url = start_fake(fake).await;

        let client = RtorrentClient::new(&config(&base_url, "")).unwrap();
        let list = client.list_torrents().await.unwrap();

        assert_eq!(list.len(), 3);
        assert_eq!(list[0].name, "Newer");
        assert_eq!(list[0].state, "seeding");
        assert_eq!(list[0].progress, 1.0);
        assert_eq!(list[0].ratio, 1.5);
        assert_eq!(list[1].name, "MagnetMeta");
        assert_eq!(list[1].state, "metadata");
        assert_eq!(list[2].name, "Older");
        assert_eq!(list[2].state, "stopped");
        assert_eq!(list[2].category, "my label");
    }

    #[tokio::test]
    async fn adds_paused_magnets_and_files_and_rejects_duplicates() {
        let file = sample_torrent_file();
        let fake = FakeRtorrent::new(Vec::new());
        let base_url = start_fake(fake.clone()).await;
        let client = RtorrentClient::new(&config(&base_url, "")).unwrap();

        let magnet = format!("magnet:?xt=urn:btih:{HASH}&dn=Example");
        let result = client
            .add_torrent(
                &[magnet],
                std::slice::from_ref(&file),
                "remagnet",
                &[],
                true,
            )
            .await
            .unwrap();
        assert_eq!(result.added, 2);
        assert_eq!(result.category, "remagnet");
        assert_eq!(
            result.hashes,
            vec![HASH.to_string(), file.info_hash.clone()]
        );

        let bodies: Vec<String> = fake.requests().into_iter().map(|(_, body)| body).collect();
        assert!(bodies
            .iter()
            .any(|body| body.contains("<methodName>load.normal</methodName>")
                && body.contains("d.custom1.set=remagnet")));
        assert!(bodies
            .iter()
            .any(|body| body.contains("<methodName>load.raw</methodName>")
                && body.contains("<base64>")
                && body.contains("d.custom1.set=remagnet")));

        // Seed the uploaded torrent in the fake server and verify duplicate rejection.
        fake.state
            .lock()
            .unwrap()
            .torrents
            .push(FakeTorrent::sample(
                &file.info_hash,
                "sample",
                false,
                "3000",
            ));
        let duplicate = client
            .add_torrent(&[], &[file], "remagnet", &[], true)
            .await
            .unwrap_err();
        assert!(
            matches!(duplicate, AppError::BadRequest(_)),
            "{duplicate:?}"
        );
    }

    #[tokio::test]
    async fn archives_multi_file_torrents_and_skips_zero_priority_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("Album/sub")).unwrap();
        std::fs::write(dir.path().join("Album/sub/track.bin"), b"rtorrent bytes").unwrap();

        let mut entry = FakeTorrent::sample(HASH, "Album", true, "5000");
        entry.directory = "/downloads/Album".to_string();
        entry.is_multi_file = 1;
        entry.files = vec![
            ("sub/track.bin".to_string(), 14, 1, 1, 1),
            ("skip.txt".to_string(), 100, 0, 1, 0),
        ];

        let fake = FakeRtorrent::new(vec![entry]);
        let base_url = start_fake(fake).await;

        let client = RtorrentClient::new(&config(&base_url, dir.path().to_str().unwrap())).unwrap();
        let archive = client.archive_torrent(HASH).await.unwrap();
        assert_eq!(archive.download_dir.as_deref(), Some("/downloads"));

        let files = client.files(HASH).await.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "Album/sub/track.bin");
        assert_eq!(files[0].progress, 1.0);

        let mut stream = client.open_file(&archive, &files[0]).await.unwrap();
        let mut content = Vec::new();
        while let Some(chunk) = stream.next().await {
            content.extend_from_slice(&chunk.unwrap());
        }
        assert_eq!(content, b"rtorrent bytes");
    }

    #[tokio::test]
    async fn removes_torrents_and_marks_custom5_when_deleting_files() {
        let fake = FakeRtorrent::new(vec![FakeTorrent::sample(HASH, "Done", true, "1000")]);
        let base_url = start_fake(fake.clone()).await;

        let client = RtorrentClient::new(&config(&base_url, "")).unwrap();
        client.remove_torrent(HASH, true).await.unwrap();

        let bodies: Vec<String> = fake.requests().into_iter().map(|(_, body)| body).collect();
        assert!(bodies
            .iter()
            .any(|body| body.contains("<methodName>d.custom5.set</methodName>")));
        assert!(bodies
            .iter()
            .any(|body| body.contains("<methodName>d.erase</methodName>")));
        assert!(client.get_torrent(HASH).await.unwrap().is_none());
    }
}
