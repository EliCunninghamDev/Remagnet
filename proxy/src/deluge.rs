use std::{
    collections::HashMap,
    io::Read as _,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use flate2::read::GzDecoder;
use reqwest::{
    header::{ACCEPT, ACCEPT_ENCODING, CONTENT_ENCODING},
    StatusCode,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::{
    backend::{
        build_http_client, primary_label, AddTorrentResult, ArchiveFile, ArchiveTorrent,
        BackendHealth, ClientKind, FileByteStream, TorrentCapabilities, TorrentFilePayload,
        TorrentSummary, VolumeMapper, AUTH_RETRY_ATTEMPTS,
    },
    config::Config,
    error::AppError,
};

/// Upper bound for decompressing a single Deluge JSON-RPC response body.
const MAX_RESPONSE_BYTES: u64 = 32 * 1024 * 1024;

/// How many times to poll the Web UI while it connects to its daemon.
const DAEMON_CONNECT_ATTEMPTS: usize = 15;
/// Delay between daemon connection polls.
const DAEMON_CONNECT_POLL_INTERVAL: Duration = Duration::from_millis(100);
/// Deluge enables the Label plugin asynchronously after the Web UI connects to
/// its daemon, so the first label call can arrive before its RPC methods exist.
const LABEL_READY_ATTEMPTS: usize = 20;
/// Delay between Label plugin readiness polls.
const LABEL_READY_POLL_INTERVAL: Duration = Duration::from_millis(50);
/// gzip stream marker, used when the response header omits `Content-Encoding`.
const GZIP_MAGIC: [u8; 2] = [0x1f, 0x8b];
/// Position of the connection status in a `web.get_hosts` host entry.
const HOST_STATUS_INDEX: usize = 3;
/// JSON-RPC error code Deluge returns for an unauthenticated session.
const DELUGE_ERR_UNAUTHENTICATED: i64 = 1;

const TORRENT_KEYS: &[&str] = &[
    "hash",
    "name",
    "state",
    "progress",
    "total_size",
    "total_wanted",
    "total_remaining",
    "download_payload_rate",
    "upload_payload_rate",
    "eta",
    "ratio",
    "label",
    "num_seeds",
    "num_peers",
    "time_added",
    "save_path",
    "download_location",
    "paused",
    "message",
];

const ARCHIVE_KEYS: &[&str] = &[
    "hash",
    "name",
    "state",
    "progress",
    "total_size",
    "total_wanted",
    "total_remaining",
    "label",
    "save_path",
    "download_location",
];

const FILE_KEYS: &[&str] = &["files", "file_progress", "file_priorities"];

/// Minimal Deluge Web UI JSON-RPC client.
///
/// Deluge Web UI authenticates with a password via `auth.login`, stores the
/// session in the `_session_id` cookie, and gzip-compresses JSON responses by
/// default. When the Web UI is not yet connected to a `deluged` daemon, this
/// client automatically connects to the first available host.
#[derive(Clone)]
pub struct DelugeClient {
    rpc_url: String,
    password: String,
    http: reqwest::Client,
    next_id: Arc<AtomicU64>,
    logged_in: Arc<AtomicBool>,
    login_lock: Arc<Mutex<()>>,
    volume: VolumeMapper,
}

#[derive(Debug)]
enum RpcFailure {
    App(AppError),
    Rpc { code: Option<i64>, message: String },
}

impl RpcFailure {
    fn into_app_error(self, method: &str) -> AppError {
        match self {
            Self::App(error) => error,
            Self::Rpc { message, .. } => {
                AppError::Upstream(format!("Deluge returned an error for {method}: {message}"))
            }
        }
    }
}

impl DelugeClient {
    pub fn new(config: &Config) -> anyhow::Result<Self> {
        let http = build_http_client("Deluge", true)?;

        Ok(Self {
            rpc_url: rpc_url(&config.base_url),
            password: config.password.clone(),
            http,
            next_id: Arc::new(AtomicU64::new(1)),
            logged_in: Arc::new(AtomicBool::new(false)),
            login_lock: Arc::new(Mutex::new(())),
            volume: VolumeMapper::from_config(config),
        })
    }

    pub async fn test_connection(&self) -> Result<BackendHealth, AppError> {
        let version = match self.rpc_raw("daemon.get_version", json!([])).await {
            Ok(value) => value,
            Err(RpcFailure::Rpc { .. }) => self.rpc("daemon.info", json!([])).await?,
            Err(other) => return Err(other.into_app_error("daemon.get_version")),
        };
        let app_version = version.as_str().unwrap_or_default().trim().to_string();

        let web_api_version = match self.rpc_raw("core.get_libtorrent_version", json!([])).await {
            Ok(value) => value.as_str().unwrap_or_default().trim().to_string(),
            Err(RpcFailure::Rpc { .. }) => String::new(),
            Err(other) => return Err(other.into_app_error("core.get_libtorrent_version")),
        };

        let label_supported = self.has_label_plugin().await?;

        Ok(BackendHealth {
            client_label: ClientKind::Deluge.label().to_string(),
            app_version,
            web_api_version,
            capabilities: TorrentCapabilities {
                pause_on_add: true,
                archive_download: self.volume.is_configured(),
                categories: label_supported,
                tags: false,
                torrent_files: true,
            },
        })
    }

    pub async fn list_torrents(&self) -> Result<Vec<TorrentSummary>, AppError> {
        let mut torrents = self.fetch_torrents(None).await?;
        // Match qBittorrent and Transmission by listing newest additions first.
        torrents.sort_by(|left, right| right.time_added.total_cmp(&left.time_added));
        Ok(torrents.iter().map(RawTorrent::summary).collect())
    }

    /// Fetch a torrent without applying the proxy's category/tag filter.
    ///
    /// Duplicate checks must see every torrent in the client, including ones
    /// that were added elsewhere and are not owned by Remagnet.
    pub async fn get_torrent(&self, hash: &str) -> Result<Option<TorrentSummary>, AppError> {
        Ok(self
            .fetch_torrents(Some(hash))
            .await?
            .into_iter()
            .find(|torrent| torrent.hash.eq_ignore_ascii_case(hash))
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

        let label = primary_label(category, tags).to_ascii_lowercase();

        if !label.is_empty() {
            self.ensure_label(&label).await?;
        }

        let options = json!({ "add_paused": paused });
        let mut hashes = Vec::new();

        for url in urls {
            let trimmed = url.trim();
            let method = if trimmed.to_ascii_lowercase().starts_with("magnet:") {
                "core.add_torrent_magnet"
            } else {
                "core.add_torrent_url"
            };

            let result = self
                .rpc_raw(method, json!([trimmed, options]))
                .await
                .map_err(|failure| map_add_failure(failure, method))?;

            hashes.push(
                self.record_added(
                    result,
                    &label,
                    "Deluge rejected the torrent. It may already exist, or the link may be invalid.",
                )
                .await?,
            );
        }

        for file in files {
            let result = self
                .rpc_raw(
                    "core.add_torrent_file",
                    json!([file.filename, file.base64, options]),
                )
                .await
                .map_err(|failure| map_add_failure(failure, "core.add_torrent_file"))?;

            hashes.push(
                self.record_added(result, &label, "Deluge already has this torrent.")
                    .await?,
            );
        }

        Ok(AddTorrentResult {
            added: urls.len() + files.len(),
            hashes,
            category: label,
            tags: Vec::new(),
        })
    }

    /// Validate the hash an add call returned and apply the Deluge label to it.
    async fn record_added(
        &self,
        result: Value,
        label: &str,
        rejected_message: &str,
    ) -> Result<String, AppError> {
        let added_hash = result
            .as_str()
            .map(str::trim)
            .filter(|hash| !hash.is_empty())
            .map(str::to_ascii_lowercase)
            .ok_or_else(|| AppError::BadRequest(rejected_message.to_string()))?;

        if !label.is_empty() {
            self.label_rpc("label.set_torrent", json!([&added_hash, label]))
                .await?;
        }

        Ok(added_hash)
    }

    pub async fn remove_torrent(&self, hash: &str, delete_files: bool) -> Result<(), AppError> {
        let removed = self
            .rpc(
                "core.remove_torrent",
                json!([hash.to_ascii_lowercase(), delete_files]),
            )
            .await?;
        if removed == Value::Bool(false) {
            return Err(AppError::NotFound(
                "Torrent not found in Deluge.".to_string(),
            ));
        }
        Ok(())
    }

    pub async fn archive_torrent(&self, hash: &str) -> Result<ArchiveTorrent, AppError> {
        let filter = json!({ "id": [hash.to_ascii_lowercase()] });
        let raw = self
            .rpc("core.get_torrents_status", json!([filter, ARCHIVE_KEYS]))
            .await?;
        let map: HashMap<String, RawArchive> = serde_json::from_value(raw).map_err(|error| {
            tracing::warn!(error = %error, "could not parse Deluge archive torrent data");
            AppError::upstream_unreadable("Deluge")
        })?;

        let (key, torrent) = map
            .into_iter()
            .find(|(key, torrent)| {
                let candidate = if torrent.hash.is_empty() {
                    key.as_str()
                } else {
                    torrent.hash.as_str()
                };
                candidate.eq_ignore_ascii_case(hash)
            })
            .ok_or_else(|| AppError::NotFound("Torrent not found.".to_string()))?;

        let resolved_hash = if torrent.hash.is_empty() {
            key
        } else {
            torrent.hash
        };
        let download_dir = non_empty(&torrent.download_location)
            .or_else(|| non_empty(&torrent.save_path))
            .map(str::to_string);

        Ok(ArchiveTorrent {
            hash: resolved_hash.to_ascii_lowercase(),
            name: torrent.name,
            progress: (torrent.progress / 100.0).clamp(0.0, 1.0),
            amount_left: torrent.total_remaining,
            state: normalize_state(&torrent.state, torrent.total_size, torrent.total_wanted),
            category: torrent.label.trim().to_string(),
            tags: Vec::new(),
            download_dir,
        })
    }

    pub async fn files(&self, hash: &str) -> Result<Vec<ArchiveFile>, AppError> {
        let raw = self
            .rpc(
                "core.get_torrent_status",
                json!([hash.to_ascii_lowercase(), FILE_KEYS]),
            )
            .await?;

        if raw.as_object().is_some_and(serde_json::Map::is_empty) || raw.is_null() {
            return Err(AppError::NotFound("Torrent not found.".to_string()));
        }

        let status: RawTorrentFiles = serde_json::from_value(raw).map_err(|error| {
            tracing::warn!(error = %error, "could not parse Deluge torrent files");
            AppError::upstream_unreadable("Deluge")
        })?;

        let mut files = Vec::with_capacity(status.files.len());
        for (position, file) in status.files.into_iter().enumerate() {
            let priority = status.file_priorities.get(position).copied().unwrap_or(1);
            if priority == 0 {
                continue;
            }

            let progress = if file.size == 0 {
                1.0
            } else {
                status
                    .file_progress
                    .get(position)
                    .copied()
                    .unwrap_or(0.0)
                    .clamp(0.0, 1.0)
            };

            files.push(ArchiveFile {
                index: file.index.unwrap_or(position as i64),
                name: file.path,
                size: file.size,
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

    async fn fetch_torrents(&self, hash: Option<&str>) -> Result<Vec<RawTorrent>, AppError> {
        let filter = match hash {
            Some(hash) => json!({ "id": [hash.to_ascii_lowercase()] }),
            None => json!({}),
        };
        let raw = self
            .rpc("core.get_torrents_status", json!([filter, TORRENT_KEYS]))
            .await?;

        let map: HashMap<String, RawTorrent> = serde_json::from_value(raw).map_err(|error| {
            tracing::warn!(error = %error, "could not parse Deluge torrent status map");
            AppError::upstream_unreadable("Deluge")
        })?;

        Ok(map
            .into_iter()
            .map(|(key, mut torrent)| {
                if torrent.hash.is_empty() {
                    torrent.hash = key;
                }
                torrent
            })
            .collect())
    }

    async fn has_label_plugin(&self) -> Result<bool, AppError> {
        let enabled = self.string_array_rpc("core.get_enabled_plugins").await?;
        if enabled.iter().any(|name| name == "Label") {
            return Ok(true);
        }
        let available = self.string_array_rpc("core.get_available_plugins").await?;
        Ok(available.iter().any(|name| name == "Label"))
    }

    /// Call an RPC method that returns an array of strings.
    async fn string_array_rpc(&self, method: &str) -> Result<Vec<String>, AppError> {
        let value = self.rpc(method, json!([])).await?;
        Ok(value
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default())
    }

    async fn ensure_label(&self, label: &str) -> Result<(), AppError> {
        if !is_valid_deluge_label(label) {
            return Err(AppError::BadRequest(
                "Deluge labels can only contain letters, digits, hyphens, and underscores."
                    .to_string(),
            ));
        }

        let enabled = self.string_array_rpc("core.get_enabled_plugins").await?;
        if !enabled.iter().any(|name| name == "Label") {
            self.rpc("core.enable_plugin", json!(["Label"])).await?;
        }

        let existing = self.labels().await?;
        if existing.iter().any(|item| item.eq_ignore_ascii_case(label)) {
            return Ok(());
        }

        match self.label_rpc_raw("label.add", json!([label])).await {
            Ok(_) => Ok(()),
            Err(failure) => {
                // Tolerate a concurrent create race.
                let refreshed = self.labels().await?;
                if refreshed
                    .iter()
                    .any(|item| item.eq_ignore_ascii_case(label))
                {
                    Ok(())
                } else {
                    Err(failure.into_app_error("label.add"))
                }
            }
        }
    }

    async fn labels(&self) -> Result<Vec<String>, AppError> {
        let value = self.label_rpc("label.get_labels", json!([])).await?;
        Ok(value
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default())
    }

    /// Call a Label plugin method, waiting out the plugin's asynchronous load.
    async fn label_rpc(&self, method: &str, params: Value) -> Result<Value, AppError> {
        self.label_rpc_raw(method, params)
            .await
            .map_err(|failure| failure.into_app_error(method))
    }

    async fn label_rpc_raw(&self, method: &str, params: Value) -> Result<Value, RpcFailure> {
        for attempt in 0..LABEL_READY_ATTEMPTS {
            match self.rpc_raw(method, params.clone()).await {
                Ok(value) => return Ok(value),
                Err(RpcFailure::Rpc { message, .. })
                    if attempt + 1 < LABEL_READY_ATTEMPTS && is_unknown_method(&message) =>
                {
                    tokio::time::sleep(LABEL_READY_POLL_INTERVAL).await;
                }
                Err(failure) => return Err(failure),
            }
        }

        unreachable!("the retry loop always returns")
    }

    async fn ensure_login(&self) -> Result<(), AppError> {
        if self.logged_in.load(Ordering::Relaxed) {
            return Ok(());
        }
        self.login(false).await
    }

    async fn login(&self, force: bool) -> Result<(), AppError> {
        let _guard = self.login_lock.lock().await;
        if !force && self.logged_in.load(Ordering::Relaxed) {
            return Ok(());
        }

        let result = self
            .send_rpc_once("auth.login", json!([self.password]))
            .await
            .map_err(|failure| failure.into_app_error("auth.login"))?;

        if result != Value::Bool(true) {
            self.logged_in.store(false, Ordering::Relaxed);
            return Err(AppError::UpstreamAuth(
                "Deluge rejected the saved password. Update the password in the Remagnet Proxy page."
                    .to_string(),
            ));
        }

        self.ensure_daemon_connected().await?;
        self.logged_in.store(true, Ordering::Relaxed);
        Ok(())
    }

    /// Connect Deluge Web UI to its daemon if it has not connected yet.
    async fn ensure_daemon_connected(&self) -> Result<(), AppError> {
        let connected = self
            .send_rpc_once("web.connected", json!([]))
            .await
            .map_err(|failure| failure.into_app_error("web.connected"))?;
        if connected == Value::Bool(true) {
            return Ok(());
        }

        let hosts = self
            .send_rpc_once("web.get_hosts", json!([]))
            .await
            .map_err(|failure| failure.into_app_error("web.get_hosts"))?;

        let host_id = select_host_id(&hosts).ok_or_else(|| {
            AppError::Upstream(
                "Deluge Web UI is not connected to a Deluge daemon. Open the Deluge Web UI and add a daemon host."
                    .to_string(),
            )
        })?;

        self.send_rpc_once("web.connect", json!([host_id]))
            .await
            .map_err(|failure| failure.into_app_error("web.connect"))?;

        for _ in 0..DAEMON_CONNECT_ATTEMPTS {
            let status = self
                .send_rpc_once("web.connected", json!([]))
                .await
                .map_err(|failure| failure.into_app_error("web.connected"))?;
            if status == Value::Bool(true) {
                return Ok(());
            }
            tokio::time::sleep(DAEMON_CONNECT_POLL_INTERVAL).await;
        }

        Err(AppError::Upstream(
            "Deluge Web UI could not connect to its daemon in time.".to_string(),
        ))
    }

    async fn rpc(&self, method: &str, params: Value) -> Result<Value, AppError> {
        self.rpc_raw(method, params)
            .await
            .map_err(|failure| failure.into_app_error(method))
    }

    async fn rpc_raw(&self, method: &str, params: Value) -> Result<Value, RpcFailure> {
        for attempt in 0..AUTH_RETRY_ATTEMPTS {
            self.ensure_login().await.map_err(RpcFailure::App)?;
            match self.send_rpc_once(method, params.clone()).await {
                Ok(value) => return Ok(value),
                Err(RpcFailure::App(AppError::UpstreamAuth(_))) if attempt == 0 => {
                    self.login(true).await.map_err(RpcFailure::App)?;
                }
                Err(RpcFailure::Rpc { code, message })
                    if attempt == 0 && is_session_or_connection_error(code, &message) =>
                {
                    self.login(true).await.map_err(RpcFailure::App)?;
                }
                Err(RpcFailure::Rpc { code, message }) if is_auth_error(code, &message) => {
                    return Err(RpcFailure::App(AppError::UpstreamAuth(
                        "Deluge rejected the saved password. Update the password in the Remagnet Proxy page."
                            .to_string(),
                    )));
                }
                Err(other) => return Err(other),
            }
        }

        unreachable!("the retry loop always returns")
    }

    async fn send_rpc_once(&self, method: &str, params: Value) -> Result<Value, RpcFailure> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let payload = json!({
            "id": id,
            "method": method,
            "params": params,
        });

        let response = self
            .http
            .post(&self.rpc_url)
            .header(ACCEPT, "application/json")
            .header(ACCEPT_ENCODING, "gzip, identity")
            .json(&payload)
            .send()
            .await
            .map_err(|error| RpcFailure::App(AppError::from_reqwest("Deluge", error)))?;

        let status = response.status();
        let is_gzip = response
            .headers()
            .get(CONTENT_ENCODING)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.to_ascii_lowercase().contains("gzip"));

        let raw_bytes = response
            .bytes()
            .await
            .map_err(|error| RpcFailure::App(AppError::from_reqwest("Deluge", error)))?;

        let bytes = decode_body(&raw_bytes, is_gzip).map_err(|error| {
            tracing::warn!(error = %error, method, "could not decode Deluge response body");
            RpcFailure::App(AppError::upstream_unreadable("Deluge"))
        })?;

        if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
            return Err(RpcFailure::App(AppError::UpstreamAuth(
                "Deluge rejected the saved password. Update the password in the Remagnet Proxy page."
                    .to_string(),
            )));
        }

        if !status.is_success() {
            let text = String::from_utf8_lossy(&bytes);
            return Err(RpcFailure::App(AppError::upstream_status(
                "Deluge", status, method, &text,
            )));
        }

        let envelope: RpcEnvelope = serde_json::from_slice(&bytes).map_err(|error| {
            tracing::warn!(error = %error, method, "could not parse Deluge JSON-RPC response");
            RpcFailure::App(AppError::upstream_unreadable("Deluge"))
        })?;

        if let Some(error) = envelope.error {
            if !error.is_null() {
                let code = error.get("code").and_then(Value::as_i64);
                let message = error
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|message| !message.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| error.to_string());
                return Err(RpcFailure::Rpc { code, message });
            }
        }

        Ok(envelope.result.unwrap_or(Value::Null))
    }
}

#[derive(Debug, Deserialize)]
struct RpcEnvelope {
    result: Option<Value>,
    error: Option<Value>,
}

/// Normalize a base URL to Deluge Web UI's JSON-RPC endpoint, keeping an
/// explicitly configured `/json` path as-is.
fn rpc_url(base_url: &str) -> String {
    let base_url = base_url.trim().trim_end_matches('/');
    if base_url.to_ascii_lowercase().ends_with("/json") {
        base_url.to_string()
    } else {
        format!("{base_url}/json")
    }
}

fn decode_body(raw: &[u8], header_gzip: bool) -> std::io::Result<Vec<u8>> {
    let magic_gzip = raw.starts_with(&GZIP_MAGIC);
    if !header_gzip && !magic_gzip {
        return Ok(raw.to_vec());
    }

    let decoder = GzDecoder::new(raw);
    let mut limited = decoder.take(MAX_RESPONSE_BYTES + 1);
    let mut out = Vec::new();
    limited.read_to_end(&mut out)?;
    if out.len() as u64 > MAX_RESPONSE_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "compressed Deluge response exceeded safety limit",
        ));
    }
    Ok(out)
}

fn select_host_id(hosts: &Value) -> Option<String> {
    let entries = hosts.as_array()?;
    let mut fallback = None;

    for entry in entries {
        let Some(fields) = entry.as_array() else {
            continue;
        };
        let Some(id) = fields.first().and_then(Value::as_str) else {
            continue;
        };
        if id.is_empty() {
            continue;
        }
        if fallback.is_none() {
            fallback = Some(id.to_string());
        }
        let status = fields
            .get(HOST_STATUS_INDEX)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        if matches!(status.as_str(), "online" | "connected") {
            return Some(id.to_string());
        }
    }

    fallback
}

fn is_auth_error(code: Option<i64>, message: &str) -> bool {
    code == Some(DELUGE_ERR_UNAUTHENTICATED)
        || message.to_ascii_lowercase().contains("not authenticated")
}

fn is_session_or_connection_error(code: Option<i64>, message: &str) -> bool {
    if is_auth_error(code, message) {
        return true;
    }
    let lower = message.to_ascii_lowercase();
    lower.contains("not connected") || lower.contains("daemon is not connected")
}

fn is_unknown_method(message: &str) -> bool {
    message.to_ascii_lowercase().contains("unknown method")
}

fn is_valid_deluge_label(label: &str) -> bool {
    !label.is_empty()
        && label
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
}

fn map_add_failure(failure: RpcFailure, method: &str) -> AppError {
    match failure {
        RpcFailure::Rpc { message, .. } => {
            let lower = message.to_ascii_lowercase();
            if lower.contains("already in session") || lower.contains("already exists") {
                AppError::BadRequest("Deluge already has this torrent.".to_string())
            } else if lower.contains("invalid")
                || lower.contains("bdecode")
                || lower.contains("magnet")
            {
                AppError::BadRequest(
                    "Deluge rejected the torrent. The magnet link or .torrent file may be invalid."
                        .to_string(),
                )
            } else {
                AppError::Upstream(format!("Deluge returned an error for {method}: {message}"))
            }
        }
        other => other.into_app_error(method),
    }
}

fn non_empty(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// Collapse a Deluge state string into the client-neutral state set.
fn normalize_state(state: &str, total_size: u64, total_wanted: u64) -> String {
    match state.trim() {
        "Error" => "error",
        "Paused" => "stopped",
        "Checking" | "Allocating" => "checking",
        "Queued" => "queued",
        "Moving" => "moving",
        "Seeding" => "seeding",
        "Downloading" => {
            if total_size == 0 && total_wanted == 0 {
                "metadata"
            } else {
                "downloading"
            }
        }
        _ => "unknown",
    }
    .to_string()
}

#[derive(Debug, Clone, Default, Deserialize)]
struct RawTorrent {
    #[serde(default)]
    hash: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    progress: f64,
    #[serde(default)]
    total_size: u64,
    #[serde(default)]
    total_wanted: u64,
    #[serde(default)]
    download_payload_rate: u64,
    #[serde(default)]
    upload_payload_rate: u64,
    #[serde(default)]
    eta: i64,
    #[serde(default)]
    ratio: f64,
    #[serde(default)]
    label: String,
    #[serde(default)]
    num_seeds: u64,
    #[serde(default)]
    num_peers: u64,
    #[serde(default)]
    time_added: f64,
}

impl RawTorrent {
    fn summary(&self) -> TorrentSummary {
        TorrentSummary {
            hash: self.hash.to_ascii_lowercase(),
            name: self.name.clone(),
            state: normalize_state(&self.state, self.total_size, self.total_wanted),
            progress: (self.progress / 100.0).clamp(0.0, 1.0),
            size: if self.total_wanted > 0 {
                self.total_wanted
            } else {
                self.total_size
            },
            download_speed: self.download_payload_rate,
            upload_speed: self.upload_payload_rate,
            eta: if self.eta < 0 { -1 } else { self.eta },
            ratio: if self.ratio < 0.0 { 0.0 } else { self.ratio },
            category: self.label.trim().to_string(),
            tags: Vec::new(),
            seeds: self.num_seeds,
            peers: self.num_peers,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
struct RawArchive {
    #[serde(default)]
    hash: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    progress: f64,
    #[serde(default)]
    total_size: u64,
    #[serde(default)]
    total_wanted: u64,
    #[serde(default)]
    total_remaining: u64,
    #[serde(default)]
    label: String,
    #[serde(default)]
    save_path: String,
    #[serde(default)]
    download_location: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct RawTorrentFiles {
    #[serde(default)]
    files: Vec<RawFile>,
    #[serde(default)]
    file_progress: Vec<f64>,
    #[serde(default)]
    file_priorities: Vec<i64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct RawFile {
    #[serde(default)]
    index: Option<i64>,
    #[serde(default)]
    path: String,
    #[serde(default)]
    size: u64,
}

#[cfg(test)]
mod tests {
    use std::{
        io::Write as _,
        sync::{Arc, Mutex},
    };

    use axum::{
        body::Body,
        extract::State,
        http::{header, Request},
        response::Response,
        Router,
    };
    use flate2::{write::GzEncoder, Compression};
    use futures_lite::StreamExt;
    use http_body_util::BodyExt;
    use serde_json::{json, Value};

    use super::*;
    use crate::backend::extract_magnet_hashes;

    const HASH: &str = "dc555f7a26f1acae38a18edc04e53588ade33051";

    #[derive(Clone)]
    struct FakeDeluge {
        state: Arc<Mutex<FakeState>>,
    }

    struct FakeState {
        password: String,
        connected: bool,
        gzip: bool,
        expire_after: Option<usize>,
        authed_calls: usize,
        session_cookie: String,
        version: String,
        libtorrent_version: String,
        enabled_plugins: Vec<String>,
        available_plugins: Vec<String>,
        labels: Vec<String>,
        torrents: HashMap<String, Value>,
        duplicate_hashes: Vec<String>,
        requests: Vec<Value>,
    }

    impl FakeDeluge {
        fn new(torrents: HashMap<String, Value>) -> Self {
            Self {
                state: Arc::new(Mutex::new(FakeState {
                    password: "deluge".to_string(),
                    connected: true,
                    gzip: true,
                    expire_after: None,
                    authed_calls: 0,
                    session_cookie: "sess-1".to_string(),
                    version: "2.1.1".to_string(),
                    libtorrent_version: "2.0.10.0".to_string(),
                    enabled_plugins: vec!["Label".to_string()],
                    available_plugins: vec!["Label".to_string()],
                    labels: vec!["remagnet".to_string()],
                    torrents,
                    duplicate_hashes: Vec::new(),
                    requests: Vec::new(),
                })),
            }
        }

        fn requests(&self) -> Vec<Value> {
            self.state.lock().unwrap().requests.clone()
        }

        fn request(&self, method: &str) -> Value {
            self.requests()
                .into_iter()
                .find(|request| request["method"] == method)
                .unwrap_or_else(|| panic!("{method} was not requested"))
        }
    }

    fn encode_response(body: &Value, gzip: bool, cookie: Option<&str>) -> Response {
        let json_bytes = serde_json::to_vec(body).unwrap();
        let mut builder = Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(cookie) = cookie {
            builder = builder.header(header::SET_COOKIE, format!("_session_id={cookie}; Path=/"));
        }

        if gzip {
            let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(&json_bytes).unwrap();
            let compressed = encoder.finish().unwrap();
            builder
                .header(CONTENT_ENCODING, "gzip")
                .body(Body::from(compressed))
                .unwrap()
        } else {
            builder.body(Body::from(json_bytes)).unwrap()
        }
    }

    async fn fake_rpc(State(fake): State<FakeDeluge>, request: Request<Body>) -> Response {
        let cookie_header = request
            .headers()
            .get(header::COOKIE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();

        let body_bytes = request.into_body().collect().await.unwrap().to_bytes();
        let payload: Value = serde_json::from_slice(&body_bytes).unwrap();
        let id = payload["id"].clone();
        let method = payload["method"].as_str().unwrap_or_default().to_string();
        let params = payload["params"].as_array().cloned().unwrap_or_default();

        let mut state = fake.state.lock().unwrap();
        state.requests.push(payload.clone());
        let gzip = state.gzip;

        if method == "auth.login" {
            let password = params.first().and_then(Value::as_str).unwrap_or_default();
            if password == state.password {
                let cookie = state.session_cookie.clone();
                return encode_response(
                    &json!({ "id": id, "result": true, "error": null }),
                    gzip,
                    Some(&cookie),
                );
            }
            return encode_response(
                &json!({ "id": id, "result": false, "error": null }),
                gzip,
                None,
            );
        }

        let expected_cookie = format!("_session_id={}", state.session_cookie);
        if !cookie_header.contains(&expected_cookie) {
            return encode_response(
                &json!({
                    "id": id,
                    "result": null,
                    "error": { "message": "Not authenticated", "code": 1 }
                }),
                gzip,
                None,
            );
        }

        if let Some(limit) = state.expire_after {
            if state.authed_calls >= limit && method != "web.connected" {
                state.session_cookie = "sess-2".to_string();
                state.expire_after = None;
                return encode_response(
                    &json!({
                        "id": id,
                        "result": null,
                        "error": { "message": "Not authenticated", "code": 1 }
                    }),
                    gzip,
                    None,
                );
            }
            state.authed_calls += 1;
        }

        let reply = match method.as_str() {
            "web.connected" => json!({ "id": id, "result": state.connected, "error": null }),
            "web.get_hosts" => json!({
                "id": id,
                "result": [
                    ["host-offline", "127.0.0.1", 58847, "Offline"],
                    ["host-online", "127.0.0.1", 58846, "Online"]
                ],
                "error": null
            }),
            "web.connect" => {
                if params.first().and_then(Value::as_str) == Some("host-online") {
                    state.connected = true;
                    json!({ "id": id, "result": true, "error": null })
                } else {
                    json!({ "id": id, "result": null, "error": { "message": "Unknown host", "code": 3 } })
                }
            }
            "daemon.get_version" => {
                json!({ "id": id, "result": state.version, "error": null })
            }
            "core.get_libtorrent_version" => {
                json!({ "id": id, "result": state.libtorrent_version, "error": null })
            }
            "core.get_enabled_plugins" => {
                json!({ "id": id, "result": state.enabled_plugins, "error": null })
            }
            "core.get_available_plugins" => {
                json!({ "id": id, "result": state.available_plugins, "error": null })
            }
            "core.enable_plugin" => {
                if let Some(name) = params.first().and_then(Value::as_str) {
                    if !state.enabled_plugins.iter().any(|p| p == name) {
                        state.enabled_plugins.push(name.to_string());
                    }
                }
                json!({ "id": id, "result": true, "error": null })
            }
            "label.get_labels" => json!({ "id": id, "result": state.labels, "error": null }),
            "label.add" => {
                if let Some(label) = params.first().and_then(Value::as_str) {
                    state.labels.push(label.to_string());
                }
                json!({ "id": id, "result": null, "error": null })
            }
            "label.set_torrent" => {
                if let (Some(hash), Some(label)) = (
                    params.first().and_then(Value::as_str),
                    params.get(1).and_then(Value::as_str),
                ) {
                    if let Some(torrent) = state.torrents.get_mut(hash) {
                        torrent["label"] = json!(label);
                    }
                }
                json!({ "id": id, "result": null, "error": null })
            }
            "core.get_torrents_status" => {
                let ids = params
                    .first()
                    .and_then(|filter| filter.get("id"))
                    .and_then(Value::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_ascii_lowercase)
                            .collect::<Vec<_>>()
                    });
                let mut result = serde_json::Map::new();
                for (hash, torrent) in &state.torrents {
                    let include = match &ids {
                        None => true,
                        Some(ids) => ids.iter().any(|id| id.eq_ignore_ascii_case(hash)),
                    };
                    if include {
                        result.insert(hash.clone(), torrent.clone());
                    }
                }
                json!({ "id": id, "result": Value::Object(result), "error": null })
            }
            "core.get_torrent_status" => {
                let hash = params
                    .first()
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                let result = state
                    .torrents
                    .get(&hash)
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                json!({ "id": id, "result": result, "error": null })
            }
            "core.add_torrent_magnet" | "core.add_torrent_url" => {
                let url = params.first().and_then(Value::as_str).unwrap_or_default();
                let hash = extract_magnet_hashes(&[url.to_string()])
                    .into_iter()
                    .next()
                    .unwrap_or_else(|| HASH.to_string());
                if state.duplicate_hashes.contains(&hash) {
                    json!({
                        "id": id,
                        "result": null,
                        "error": { "message": "Torrent already in session", "code": 4 }
                    })
                } else {
                    json!({ "id": id, "result": hash, "error": null })
                }
            }
            "core.add_torrent_file" => {
                let b64 = params.get(1).and_then(Value::as_str).unwrap_or_default();
                let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64)
                    .unwrap();
                let hash = crate::bencode::extract_info_hash(&bytes).unwrap();
                if state.duplicate_hashes.contains(&hash) {
                    json!({
                        "id": id,
                        "result": null,
                        "error": { "message": "AddTorrentError: Torrent already in session", "code": 4 }
                    })
                } else {
                    json!({ "id": id, "result": hash, "error": null })
                }
            }
            "core.remove_torrent" => json!({ "id": id, "result": true, "error": null }),
            _ => json!({
                "id": id,
                "result": null,
                "error": { "message": format!("Unknown method: {method}"), "code": 2 }
            }),
        };

        encode_response(&reply, gzip, None)
    }

    async fn start_fake(fake: FakeDeluge) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().fallback(fake_rpc).with_state(fake);
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{address}")
    }

    fn config(base_url: &str, downloads_dir: &str) -> Config {
        Config {
            client_kind: ClientKind::Deluge,
            base_url: base_url.to_string(),
            api_key: String::new(),
            username: String::new(),
            password: "deluge".to_string(),
            downloads_dir: downloads_dir.to_string(),
            client_downloads_dir: "/downloads".to_string(),
            default_category: "remagnet".to_string(),
            default_tags: Vec::new(),
        }
    }

    fn sample_torrent(hash: &str, name: &str, state: &str, time_added: f64) -> Value {
        json!({
            "hash": hash,
            "name": name,
            "state": state,
            "progress": 50.0,
            "total_size": 1000,
            "total_wanted": 1000,
            "total_remaining": 500,
            "download_payload_rate": 250,
            "upload_payload_rate": 50,
            "eta": 2,
            "ratio": 1.25,
            "label": "remagnet",
            "num_seeds": 4,
            "num_peers": 2,
            "time_added": time_added,
            "download_location": "/downloads",
            "save_path": "/downloads",
            "paused": state == "Paused",
            "message": "OK",
        })
    }

    fn sample_torrent_file() -> TorrentFilePayload {
        let info =
            b"d6:lengthi4096e4:name4:test12:piece lengthi16384e6:pieces20:01234567890123456789e";
        let mut bytes = b"d4:info".to_vec();
        bytes.extend_from_slice(info);
        bytes.push(b'e');
        let info_hash = crate::bencode::extract_info_hash(&bytes).unwrap();
        let base64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
        TorrentFilePayload {
            filename: "sample.torrent".to_string(),
            bytes,
            base64,
            info_hash,
        }
    }

    #[test]
    fn endpoint_url_keeps_explicit_json_path() {
        assert_eq!(rpc_url("http://deluge:8112"), "http://deluge:8112/json");
        assert_eq!(rpc_url("http://deluge:8112/"), "http://deluge:8112/json");
        assert_eq!(
            rpc_url("http://deluge:8112/json"),
            "http://deluge:8112/json"
        );
        assert_eq!(
            rpc_url("https://seedbox.example.com/deluge/JSON/"),
            "https://seedbox.example.com/deluge/JSON"
        );
    }

    #[tokio::test]
    async fn authenticates_auto_connects_daemon_and_decodes_gzip_responses() {
        let fake = FakeDeluge::new(HashMap::new());
        fake.state.lock().unwrap().connected = false;
        let base_url = start_fake(fake.clone()).await;

        let client = DelugeClient::new(&config(&base_url, "")).unwrap();
        let health = client.test_connection().await.unwrap();

        assert_eq!(health.client_label, "Deluge");
        assert_eq!(health.app_version, "2.1.1");
        assert_eq!(health.web_api_version, "2.0.10.0");
        assert!(health.capabilities.pause_on_add);
        assert!(!health.capabilities.archive_download);
        assert!(health.capabilities.categories);
        assert!(!health.capabilities.tags);
        assert!(health.capabilities.torrent_files);

        let connect = fake.request("web.connect");
        assert_eq!(connect["params"], json!(["host-online"]));
    }

    #[tokio::test]
    async fn rejects_wrong_password_as_upstream_auth() {
        let fake = FakeDeluge::new(HashMap::new());
        let base_url = start_fake(fake).await;

        let mut cfg = config(&base_url, "");
        cfg.password = "wrong".to_string();
        let client = DelugeClient::new(&cfg).unwrap();

        let error = client.test_connection().await.unwrap_err();
        assert!(matches!(error, AppError::UpstreamAuth(_)), "{error:?}");
    }

    #[tokio::test]
    async fn recovers_when_deluge_session_expires() {
        let fake = FakeDeluge::new(HashMap::new());
        fake.state.lock().unwrap().expire_after = Some(2);
        let base_url = start_fake(fake.clone()).await;

        let client = DelugeClient::new(&config(&base_url, "")).unwrap();
        client.test_connection().await.unwrap();
        let list = client.list_torrents().await.unwrap();
        assert!(list.is_empty());

        let logins = fake
            .requests()
            .into_iter()
            .filter(|req| req["method"] == "auth.login")
            .count();
        assert_eq!(logins, 2);
    }

    #[tokio::test]
    async fn lists_torrents_normalized_and_newest_first() {
        let mut torrents = HashMap::new();
        let old_hash = "1".repeat(40);
        let new_hash = "2".repeat(40);
        let meta_hash = "3".repeat(40);
        torrents.insert(
            old_hash.clone(),
            sample_torrent(&old_hash, "Older", "Paused", 100.0),
        );
        torrents.insert(
            new_hash.clone(),
            sample_torrent(&new_hash, "Newer", "Downloading", 200.0),
        );
        let mut meta = sample_torrent(&meta_hash, "MagnetMeta", "Downloading", 150.0);
        meta["total_size"] = json!(0);
        meta["total_wanted"] = json!(0);
        torrents.insert(meta_hash.clone(), meta);

        let fake = FakeDeluge::new(torrents);
        let base_url = start_fake(fake).await;

        let client = DelugeClient::new(&config(&base_url, "")).unwrap();
        let list = client.list_torrents().await.unwrap();

        assert_eq!(list.len(), 3);
        assert_eq!(list[0].name, "Newer");
        assert_eq!(list[0].state, "downloading");
        assert!((list[0].progress - 0.5).abs() < 1e-9);
        assert_eq!(list[0].category, "remagnet");
        assert_eq!(list[1].name, "MagnetMeta");
        assert_eq!(list[1].state, "metadata");
        assert_eq!(list[2].name, "Older");
        assert_eq!(list[2].state, "stopped");
    }

    #[tokio::test]
    async fn adds_magnets_and_files_enabling_label_plugin_and_creating_label() {
        let fake = FakeDeluge::new(HashMap::new());
        {
            let mut state = fake.state.lock().unwrap();
            state.enabled_plugins.clear();
            state.labels.clear();
        }
        let base_url = start_fake(fake.clone()).await;
        let client = DelugeClient::new(&config(&base_url, "")).unwrap();

        let magnet = format!("magnet:?xt=urn:btih:{HASH}&dn=Example");
        let file = sample_torrent_file();
        let result = client
            .add_torrent(
                &[magnet],
                std::slice::from_ref(&file),
                "Remagnet",
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

        assert_eq!(
            fake.request("core.enable_plugin")["params"],
            json!(["Label"])
        );
        assert_eq!(fake.request("label.add")["params"], json!(["remagnet"]));
        assert_eq!(
            fake.request("core.add_torrent_magnet")["params"][1],
            json!({ "add_paused": true })
        );
        assert_eq!(
            fake.request("core.add_torrent_file")["params"][0],
            json!("sample.torrent")
        );

        let set_labels: Vec<Value> = fake
            .requests()
            .into_iter()
            .filter(|req| req["method"] == "label.set_torrent")
            .collect();
        assert_eq!(set_labels.len(), 2);
    }

    #[tokio::test]
    async fn rejects_duplicate_torrent_uploads_as_bad_request() {
        let file = sample_torrent_file();
        let fake = FakeDeluge::new(HashMap::new());
        fake.state
            .lock()
            .unwrap()
            .duplicate_hashes
            .push(file.info_hash.clone());
        let base_url = start_fake(fake).await;

        let client = DelugeClient::new(&config(&base_url, "")).unwrap();
        let error = client
            .add_torrent(&[], &[file], "remagnet", &[], false)
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::BadRequest(_)), "{error:?}");
    }

    #[tokio::test]
    async fn archives_files_and_skips_unwanted_entries() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("keep.bin"), b"hello deluge").unwrap();

        let mut torrents = HashMap::new();
        let mut entry = sample_torrent(HASH, "Pack", "Seeding", 300.0);
        entry["progress"] = json!(100.0);
        entry["total_remaining"] = json!(0);
        entry["files"] = json!([
            { "index": 0, "path": "keep.bin", "size": 12 },
            { "index": 1, "path": "skip.bin", "size": 100 }
        ]);
        entry["file_progress"] = json!([1.0, 0.0]);
        entry["file_priorities"] = json!([4, 0]);
        torrents.insert(HASH.to_string(), entry);

        let fake = FakeDeluge::new(torrents);
        let base_url = start_fake(fake).await;

        let client = DelugeClient::new(&config(&base_url, dir.path().to_str().unwrap())).unwrap();
        let archive = client.archive_torrent(HASH).await.unwrap();
        assert_eq!(archive.progress, 1.0);
        assert_eq!(archive.amount_left, 0);

        let files = client.files(HASH).await.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "keep.bin");
        assert_eq!(files[0].progress, 1.0);

        let mut stream = client.open_file(&archive, &files[0]).await.unwrap();
        let mut content = Vec::new();
        while let Some(chunk) = stream.next().await {
            content.extend_from_slice(&chunk.unwrap());
        }
        assert_eq!(content, b"hello deluge");
    }

    #[tokio::test]
    async fn removes_torrents_with_delete_files_flag() {
        let fake = FakeDeluge::new(HashMap::new());
        let base_url = start_fake(fake.clone()).await;

        let client = DelugeClient::new(&config(&base_url, "")).unwrap();
        client
            .remove_torrent(&HASH.to_ascii_uppercase(), true)
            .await
            .unwrap();

        let remove = fake.request("core.remove_torrent");
        assert_eq!(remove["params"], json!([HASH, true]));
    }
}
