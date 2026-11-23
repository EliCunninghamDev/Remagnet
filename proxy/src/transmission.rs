use std::sync::Arc;

use reqwest::StatusCode;
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use tokio::sync::RwLock;

use crate::{
    backend::{
        extract_magnet_hashes, AddTorrentResult, ArchiveFile, ArchiveTorrent, BackendHealth,
        ClientKind, FileByteStream, TorrentCapabilities, TorrentSummary, VolumeMapper,
    },
    config::{normalize_tags, Config},
    error::AppError,
};

/// Transmission expects this header on every RPC call; a 409 response supplies
/// the value the client must echo back.
const SESSION_HEADER: &str = "x-transmission-session-id";

const TORRENT_FIELDS: &[&str] = &[
    "hashString",
    "name",
    "status",
    "percentDone",
    "metadataPercentComplete",
    "totalSize",
    "sizeWhenDone",
    "leftUntilDone",
    "rateDownload",
    "rateUpload",
    "eta",
    "uploadRatio",
    "labels",
    "peersSendingToUs",
    "peersGettingFromUs",
    "error",
    "errorString",
    "addedDate",
    "downloadDir",
];

const ARCHIVE_FIELDS: &[&str] = &[
    "hashString",
    "name",
    "status",
    "percentDone",
    "leftUntilDone",
    "error",
    "labels",
    "downloadDir",
];

const FILE_FIELDS: &[&str] = &["hashString", "files", "fileStats"];

/// Minimal Transmission JSON-RPC client.
///
/// Transmission protects its RPC endpoint with a session id that changes when
/// the daemon restarts. The first request is answered with `409 Conflict` and a
/// fresh id; this client caches the id and retries once automatically. Basic
/// authentication is optional because Transmission frequently runs without it
/// on a private network.
#[derive(Clone)]
pub struct TransmissionClient {
    rpc_url: String,
    auth: Option<(String, String)>,
    http: reqwest::Client,
    session_id: Arc<RwLock<Option<String>>>,
    volume: VolumeMapper,
}

impl TransmissionClient {
    pub fn new(config: &Config) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .user_agent(concat!("remagnet-bridge/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(std::time::Duration::from_secs(15))
            .read_timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(|error| {
                anyhow::anyhow!("could not build the Transmission HTTP client: {error}")
            })?;

        let auth = (!config.username.is_empty() || !config.password.is_empty())
            .then(|| (config.username.clone(), config.password.clone()));

        Ok(Self {
            rpc_url: rpc_url(&config.base_url),
            auth,
            http,
            session_id: Arc::new(RwLock::new(None)),
            volume: VolumeMapper::from_config(config),
        })
    }

    pub async fn test_connection(&self) -> Result<BackendHealth, AppError> {
        let session = self.rpc("session-get", json!({})).await?;

        let app_version = session
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let web_api_version = match session.get("rpc-version") {
            Some(Value::String(version)) => version.clone(),
            Some(version) => version.to_string(),
            None => String::new(),
        };

        Ok(BackendHealth {
            client_label: ClientKind::Transmission.label().to_string(),
            app_version,
            web_api_version,
            capabilities: TorrentCapabilities {
                pause_on_add: true,
                archive_download: self.volume.is_configured(),
                categories: false,
                tags: true,
            },
        })
    }

    pub async fn list_torrents(&self) -> Result<Vec<TorrentSummary>, AppError> {
        let mut torrents = self.fetch_torrents(None).await?;
        // Transmission's torrent-get does not guarantee an order; qBittorrent
        // lists newest additions first, so match it explicitly.
        torrents.sort_by_key(|torrent| std::cmp::Reverse(torrent.added_date));
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
            .next()
            .map(|torrent| torrent.summary()))
    }

    pub async fn add_torrent(
        &self,
        urls: &[String],
        category: &str,
        tags: &[String],
        paused: bool,
    ) -> Result<AddTorrentResult, AppError> {
        if urls.is_empty() {
            return Err(AppError::BadRequest(
                "No magnet or torrent URL was supplied.".to_string(),
            ));
        }

        let category = category.trim();
        let tags = normalize_tags(tags.iter().map(String::as_str));
        // Transmission has no categories. A configured category is stored as a
        // label so the ownership filter still finds torrents that only had a
        // category configured.
        let labels = if !tags.is_empty() {
            tags
        } else if !category.is_empty() {
            vec![category.to_string()]
        } else {
            Vec::new()
        };

        let mut hashes = Vec::new();
        for url in urls {
            let mut arguments = json!({ "filename": url, "paused": paused });
            if !labels.is_empty() {
                arguments["labels"] = json!(labels);
            }

            let response = self.rpc("torrent-add", arguments).await?;
            if response.get("torrent-duplicate").is_some() {
                return Err(AppError::BadRequest(
                    "Transmission already has this torrent.".to_string(),
                ));
            }

            match response
                .get("torrent-added")
                .and_then(|added| added.get("hashString"))
                .and_then(Value::as_str)
            {
                Some(hash) => hashes.push(hash.to_ascii_lowercase()),
                None => hashes.extend(extract_magnet_hashes(std::slice::from_ref(url))),
            }
        }

        Ok(AddTorrentResult {
            added: urls.len(),
            hashes,
            category: String::new(),
            tags: labels,
        })
    }

    pub async fn remove_torrent(&self, hash: &str, delete_files: bool) -> Result<(), AppError> {
        self.rpc(
            "torrent-remove",
            json!({
                "ids": [hash.to_ascii_lowercase()],
                "delete-local-data": delete_files,
            }),
        )
        .await?;
        Ok(())
    }

    pub async fn archive_torrent(&self, hash: &str) -> Result<ArchiveTorrent, AppError> {
        let arguments = self.torrent_get(Some(hash), ARCHIVE_FIELDS).await?;
        let torrent = torrents_from::<RawArchive>(&arguments)?
            .into_iter()
            .next()
            .ok_or_else(|| AppError::NotFound("Torrent not found.".to_string()))?;

        Ok(ArchiveTorrent {
            hash: torrent.hash_string.to_ascii_lowercase(),
            name: torrent.name,
            progress: torrent.percent_done.clamp(0.0, 1.0),
            amount_left: torrent.left_until_done,
            state: normalize_state(torrent.status, torrent.error, 0.0, 0),
            category: String::new(),
            tags: torrent.labels,
            download_dir: Some(torrent.download_dir),
        })
    }

    pub async fn files(&self, hash: &str) -> Result<Vec<ArchiveFile>, AppError> {
        let arguments = self.torrent_get(Some(hash), FILE_FIELDS).await?;
        let torrent = torrents_from::<RawTorrentFiles>(&arguments)?
            .into_iter()
            .next()
            .ok_or_else(|| AppError::NotFound("Torrent not found.".to_string()))?;

        let mut files = Vec::with_capacity(torrent.files.len());
        for (index, file) in torrent.files.into_iter().enumerate() {
            let wanted = torrent
                .file_stats
                .get(index)
                .map(|stat| stat.wanted)
                .unwrap_or(true);
            if !wanted {
                continue;
            }

            files.push(ArchiveFile {
                index: index as i64,
                name: file.name,
                size: file.length,
                progress: if file.length == 0 {
                    1.0
                } else {
                    file.bytes_completed as f64 / file.length as f64
                },
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

    async fn fetch_torrents(&self, ids: Option<&str>) -> Result<Vec<RawTorrent>, AppError> {
        let arguments = self.torrent_get(ids, TORRENT_FIELDS).await?;
        torrents_from::<RawTorrent>(&arguments)
    }

    async fn torrent_get(&self, ids: Option<&str>, fields: &[&str]) -> Result<Value, AppError> {
        let mut arguments = json!({ "fields": fields });
        if let Some(hash) = ids {
            arguments["ids"] = json!([hash.to_ascii_lowercase()]);
        }
        self.rpc("torrent-get", arguments).await
    }

    /// Send one JSON-RPC request, performing Transmission's session handshake.
    async fn rpc(&self, method: &str, arguments: Value) -> Result<Value, AppError> {
        let payload = json!({ "method": method, "arguments": arguments });

        for attempt in 0..2 {
            let session_id = self.session_id.read().await.clone();
            let mut request = self.http.post(&self.rpc_url).json(&payload);
            if let Some((username, password)) = &self.auth {
                request = request.basic_auth(username, Some(password));
            }
            if let Some(session_id) = session_id {
                request = request.header(SESSION_HEADER, session_id);
            }

            let response = request.send().await.map_err(|error| {
                AppError::Upstream(format!("Transmission request failed: {error}"))
            })?;

            let status = response.status();
            if status == StatusCode::CONFLICT {
                if attempt > 0 {
                    return Err(AppError::Upstream(format!(
                        "Transmission kept rejecting the session for {method}."
                    )));
                }

                let session_id = response
                    .headers()
                    .get(SESSION_HEADER)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string)
                    .ok_or_else(|| {
                        AppError::Upstream(format!(
                            "Transmission did not return a session id for {method}."
                        ))
                    })?;
                *self.session_id.write().await = Some(session_id);
                continue;
            }

            if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
                return Err(AppError::Upstream(
                    "Transmission rejected the saved credentials.".to_string(),
                ));
            }

            if !status.is_success() {
                let detail = response.text().await.unwrap_or_default();
                let detail = detail.trim();
                let detail = if detail.is_empty() {
                    String::new()
                } else {
                    format!(": {}", truncate(detail, 300))
                };
                return Err(AppError::Upstream(format!(
                    "Transmission returned {status} for {method}{detail}"
                )));
            }

            let body: Value = response.json().await.map_err(|error| {
                AppError::Upstream(format!(
                    "Could not parse the Transmission response for {method}: {error}"
                ))
            })?;

            let result = body
                .get("result")
                .and_then(Value::as_str)
                .unwrap_or("success");
            if result != "success" {
                return Err(AppError::Upstream(format!(
                    "Transmission returned an error for {method}: {result}"
                )));
            }

            return Ok(body.get("arguments").cloned().unwrap_or_else(|| json!({})));
        }

        unreachable!("the retry loop always returns")
    }
}

/// Normalize a base URL to Transmission's RPC endpoint, keeping an explicitly
/// configured endpoint as-is.
fn rpc_url(base_url: &str) -> String {
    let base_url = base_url.trim().trim_end_matches('/');
    if base_url.to_ascii_lowercase().ends_with("/transmission/rpc") {
        base_url.to_string()
    } else {
        format!("{base_url}/transmission/rpc")
    }
}

/// Collapse a Transmission status code into the client-neutral state set.
fn normalize_state(
    status: i64,
    error: i64,
    metadata_percent_complete: f64,
    total_size: u64,
) -> String {
    if error != 0 {
        return "error".to_string();
    }

    match status {
        0 => "stopped",
        1 | 3 | 5 => "queued",
        2 => "checking",
        4 => {
            if metadata_percent_complete < 1.0 && total_size == 0 {
                "metadata"
            } else {
                "downloading"
            }
        }
        6 => "seeding",
        _ => "unknown",
    }
    .to_string()
}

fn torrents_from<T: DeserializeOwned>(arguments: &Value) -> Result<Vec<T>, AppError> {
    let torrents = arguments
        .get("torrents")
        .cloned()
        .unwrap_or_else(|| json!([]));
    serde_json::from_value(torrents).map_err(|error| {
        AppError::Upstream(format!(
            "Could not parse the Transmission torrent data: {error}"
        ))
    })
}

fn truncate(value: &str, max_chars: usize) -> String {
    let mut truncated = value.chars().take(max_chars).collect::<String>();
    if value.chars().count() > max_chars {
        truncated.push('…');
    }
    truncated
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawTorrent {
    #[serde(default)]
    hash_string: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    status: i64,
    #[serde(default)]
    percent_done: f64,
    #[serde(default)]
    metadata_percent_complete: f64,
    #[serde(default)]
    total_size: u64,
    #[serde(default)]
    size_when_done: u64,
    #[serde(default)]
    rate_download: u64,
    #[serde(default)]
    rate_upload: u64,
    #[serde(default)]
    eta: i64,
    #[serde(default)]
    upload_ratio: f64,
    #[serde(default)]
    labels: Vec<String>,
    #[serde(default)]
    peers_sending_to_us: u64,
    #[serde(default)]
    peers_getting_from_us: u64,
    #[serde(default)]
    error: i64,
    #[serde(default)]
    added_date: i64,
}

impl RawTorrent {
    fn summary(&self) -> TorrentSummary {
        TorrentSummary {
            hash: self.hash_string.to_ascii_lowercase(),
            name: self.name.clone(),
            state: normalize_state(
                self.status,
                self.error,
                self.metadata_percent_complete,
                self.total_size,
            ),
            progress: self.percent_done.clamp(0.0, 1.0),
            size: if self.size_when_done > 0 {
                self.size_when_done
            } else {
                self.total_size
            },
            download_speed: self.rate_download,
            upload_speed: self.rate_upload,
            eta: if self.eta < 0 { -1 } else { self.eta },
            ratio: self.upload_ratio,
            category: String::new(),
            tags: self.labels.clone(),
            seeds: self.peers_sending_to_us,
            peers: self.peers_getting_from_us,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawArchive {
    #[serde(default)]
    hash_string: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    status: i64,
    #[serde(default)]
    percent_done: f64,
    #[serde(default)]
    left_until_done: u64,
    #[serde(default)]
    error: i64,
    #[serde(default)]
    labels: Vec<String>,
    #[serde(default)]
    download_dir: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawTorrentFiles {
    #[serde(default)]
    files: Vec<RawFile>,
    #[serde(default)]
    file_stats: Vec<RawFileStat>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawFile {
    #[serde(default)]
    name: String,
    #[serde(default)]
    length: u64,
    #[serde(default)]
    bytes_completed: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawFileStat {
    #[serde(default = "default_true")]
    wanted: bool,
}

fn default_true() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::{
        body::Body,
        extract::State,
        http::{header, Request, StatusCode},
        response::{IntoResponse, Response},
        Router,
    };
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    use http_body_util::BodyExt;
    use serde_json::Value;

    use super::*;

    const HASH: &str = "dc555f7a26f1acae38a18edc04e53588ade33051";

    #[derive(Clone)]
    struct FakeTransmission {
        state: Arc<Mutex<FakeState>>,
    }

    struct FakeState {
        session: String,
        next_session: Option<String>,
        rotate_after: Option<usize>,
        successes: usize,
        auth: Option<(String, String)>,
        version: String,
        rpc_version: Value,
        torrents: Vec<Value>,
        add_response: Value,
        result_override: Option<String>,
        requests: Vec<Value>,
    }

    impl FakeTransmission {
        fn new(torrents: Vec<Value>) -> Self {
            Self {
                state: Arc::new(Mutex::new(FakeState {
                    session: "session-1".to_string(),
                    next_session: None,
                    rotate_after: None,
                    successes: 0,
                    auth: None,
                    version: "4.0.6".to_string(),
                    rpc_version: json!(17),
                    torrents,
                    add_response: json!({
                        "result": "success",
                        "arguments": {
                            "torrent-added": {
                                "hashString": HASH.to_ascii_uppercase(),
                                "name": "Example",
                            }
                        }
                    }),
                    result_override: None,
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

    async fn fake_rpc(State(fake): State<FakeTransmission>, request: Request<Body>) -> Response {
        let auth = fake.state.lock().unwrap().auth.clone();
        if let Some((username, password)) = auth {
            let expected = format!("Basic {}", BASE64.encode(format!("{username}:{password}")));
            let provided = request
                .headers()
                .get(header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok());
            if provided != Some(expected.as_str()) {
                return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
            }
        }

        let session = fake.state.lock().unwrap().session.clone();
        let provided = request
            .headers()
            .get(SESSION_HEADER)
            .and_then(|value| value.to_str().ok());
        if provided != Some(session.as_str()) {
            return (StatusCode::CONFLICT, [(SESSION_HEADER, session)]).into_response();
        }

        let body = request.into_body().collect().await.unwrap().to_bytes();
        let payload: Value = serde_json::from_slice(&body).unwrap();
        let method = payload["method"].as_str().unwrap_or_default().to_string();
        let arguments = payload
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));

        {
            let mut state = fake.state.lock().unwrap();
            state.requests.push(payload.clone());

            if let Some(result) = state.result_override.clone() {
                return json_response(json!({ "result": result, "arguments": {} }));
            }

            let response = match method.as_str() {
                "session-get" => json!({
                    "result": "success",
                    "arguments": {
                        "version": state.version,
                        "rpc-version": state.rpc_version,
                    }
                }),
                "torrent-get" => {
                    let ids = arguments.get("ids").and_then(Value::as_array);
                    let torrents = state
                        .torrents
                        .iter()
                        .filter(|torrent| match ids {
                            None => true,
                            Some(ids) => ids.iter().any(|id| {
                                id.as_str().is_some_and(|id| {
                                    torrent["hashString"]
                                        .as_str()
                                        .is_some_and(|hash| hash.eq_ignore_ascii_case(id))
                                })
                            }),
                        })
                        .cloned()
                        .collect::<Vec<_>>();
                    json!({ "result": "success", "arguments": { "torrents": torrents } })
                }
                "torrent-add" => state.add_response.clone(),
                "torrent-remove" => json!({ "result": "success", "arguments": {} }),
                _ => json!({ "result": "method not recognized", "arguments": {} }),
            };

            if let (Some(after), Some(next)) = (state.rotate_after, state.next_session.clone()) {
                state.successes += 1;
                if state.successes >= after {
                    state.session = next;
                    state.next_session = None;
                }
            }

            json_response(response)
        }
    }

    fn json_response(value: Value) -> Response {
        axum::Json(value).into_response()
    }

    struct FakeServer {
        base_url: String,
    }

    async fn start_fake(fake: FakeTransmission) -> FakeServer {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().fallback(fake_rpc).with_state(fake);
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        FakeServer {
            base_url: format!("http://{address}"),
        }
    }

    fn config(base_url: &str, downloads_dir: &str) -> Config {
        Config {
            client_kind: ClientKind::Transmission,
            base_url: base_url.to_string(),
            api_key: String::new(),
            username: String::new(),
            password: String::new(),
            downloads_dir: downloads_dir.to_string(),
            client_downloads_dir: String::new(),
            default_category: "remagnet".to_string(),
            default_tags: vec!["remagnet".to_string()],
        }
    }

    fn torrent(name: &str, status: i64, added_date: i64) -> Value {
        json!({
            "hashString": format!("{added_date:040x}"),
            "name": name,
            "status": status,
            "percentDone": 0.5,
            "metadataPercentComplete": 1.0,
            "totalSize": 100,
            "sizeWhenDone": 100,
            "leftUntilDone": 50,
            "rateDownload": 10,
            "rateUpload": 5,
            "eta": 60,
            "uploadRatio": 1.5,
            "labels": ["remagnet"],
            "peersSendingToUs": 3,
            "peersGettingFromUs": 2,
            "error": 0,
            "errorString": "",
            "addedDate": added_date,
            "downloadDir": "/downloads",
        })
    }

    #[test]
    fn endpoint_url_keeps_an_explicit_rpc_path() {
        assert_eq!(
            rpc_url("http://transmission:9091"),
            "http://transmission:9091/transmission/rpc"
        );
        assert_eq!(
            rpc_url("http://transmission:9091/"),
            "http://transmission:9091/transmission/rpc"
        );
        assert_eq!(
            rpc_url("http://transmission:9091/transmission/rpc"),
            "http://transmission:9091/transmission/rpc"
        );
        assert_eq!(
            rpc_url("http://transmission:9091/Transmission/RPC"),
            "http://transmission:9091/Transmission/RPC"
        );
    }

    #[tokio::test]
    async fn reports_version_and_capabilities_without_a_volume() {
        let fake = FakeTransmission::new(Vec::new());
        let server = start_fake(fake).await;
        let client = TransmissionClient::new(&config(&server.base_url, "")).unwrap();

        let health = client.test_connection().await.unwrap();
        assert_eq!(health.client_label, "Transmission");
        assert_eq!(health.app_version, "4.0.6");
        assert_eq!(health.web_api_version, "17");
        assert_eq!(
            health.capabilities,
            TorrentCapabilities {
                pause_on_add: true,
                archive_download: false,
                categories: false,
                tags: true,
            }
        );
    }

    #[tokio::test]
    async fn accepts_a_string_rpc_version() {
        let fake = FakeTransmission::new(Vec::new());
        fake.state.lock().unwrap().rpc_version = json!("17.0");
        let server = start_fake(fake).await;
        let client = TransmissionClient::new(&config(&server.base_url, "")).unwrap();

        let health = client.test_connection().await.unwrap();
        assert_eq!(health.web_api_version, "17.0");
    }

    #[tokio::test]
    async fn capabilities_enable_archives_with_a_mounted_volume() {
        let fake = FakeTransmission::new(Vec::new());
        let server = start_fake(fake).await;
        let client = TransmissionClient::new(&config(&server.base_url, "/mnt/downloads")).unwrap();

        let health = client.test_connection().await.unwrap();
        assert!(health.capabilities.archive_download);
    }

    #[tokio::test]
    async fn performs_the_session_handshake_and_recovers_when_it_rotates() {
        let fake = FakeTransmission::new(Vec::new());
        {
            let mut state = fake.state.lock().unwrap();
            state.rotate_after = Some(1);
            state.next_session = Some("session-2".to_string());
        }
        let server = start_fake(fake.clone()).await;
        let client = TransmissionClient::new(&config(&server.base_url, "")).unwrap();

        // The first call performs the 409 handshake; the second sees the
        // rotated id and must retry transparently.
        assert_eq!(client.test_connection().await.unwrap().app_version, "4.0.6");
        assert!(client.list_torrents().await.is_ok());

        assert_eq!(fake.state.lock().unwrap().session, "session-2");
    }

    #[tokio::test]
    async fn sends_basic_auth_when_configured() {
        let fake = FakeTransmission::new(Vec::new());
        fake.state.lock().unwrap().auth = Some(("admin".to_string(), "secret".to_string()));
        let server = start_fake(fake.clone()).await;

        let mut good = config(&server.base_url, "");
        good.username = "admin".to_string();
        good.password = "secret".to_string();
        let client = TransmissionClient::new(&good).unwrap();
        assert!(client.test_connection().await.is_ok());

        let mut bad = config(&server.base_url, "");
        bad.username = "admin".to_string();
        bad.password = "wrong".to_string();
        let client = TransmissionClient::new(&bad).unwrap();
        let error = client.test_connection().await.unwrap_err();
        match error {
            AppError::Upstream(message) => {
                assert_eq!(message, "Transmission rejected the saved credentials.")
            }
            other => panic!("expected Upstream, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn lists_torrents_normalized_and_newest_first() {
        let mut torrents = vec![
            torrent("Stopped", 0, 0),
            torrent("QueuedCheck", 1, 1),
            torrent("Checking", 2, 2),
            torrent("QueuedDownload", 3, 3),
            torrent("QueuedSeed", 5, 4),
            torrent("Seeding", 6, 5),
        ];

        let mut metadata = torrent("Metadata", 4, 6);
        metadata["metadataPercentComplete"] = json!(0.25);
        metadata["totalSize"] = json!(0);
        metadata["sizeWhenDone"] = json!(0);
        torrents.push(metadata);

        let mut downloading = torrent("Downloading", 4, 7);
        downloading["percentDone"] = json!(1.5);
        downloading["eta"] = json!(-2);
        downloading["sizeWhenDone"] = json!(0);
        torrents.push(downloading);

        let mut error = torrent("Errored", 4, 8);
        error["error"] = json!(3);
        error["errorString"] = json!("No data found");
        torrents.push(error);

        torrents.push(torrent("Unknown", 99, 9));

        let fake = FakeTransmission::new(torrents);
        let server = start_fake(fake.clone()).await;
        let client = TransmissionClient::new(&config(&server.base_url, "")).unwrap();

        let listed = client.list_torrents().await.unwrap();
        let names = listed
            .iter()
            .map(|torrent| torrent.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec![
                "Unknown",
                "Errored",
                "Downloading",
                "Metadata",
                "Seeding",
                "QueuedSeed",
                "QueuedDownload",
                "Checking",
                "QueuedCheck",
                "Stopped",
            ]
        );

        let states = listed
            .iter()
            .map(|torrent| (torrent.name.as_str(), torrent.state.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            states,
            vec![
                ("Unknown", "unknown"),
                ("Errored", "error"),
                ("Downloading", "downloading"),
                ("Metadata", "metadata"),
                ("Seeding", "seeding"),
                ("QueuedSeed", "queued"),
                ("QueuedDownload", "queued"),
                ("Checking", "checking"),
                ("QueuedCheck", "queued"),
                ("Stopped", "stopped"),
            ]
        );

        let downloading = listed
            .iter()
            .find(|torrent| torrent.name == "Downloading")
            .unwrap();
        assert_eq!(downloading.progress, 1.0);
        assert_eq!(downloading.size, 100);
        assert_eq!(downloading.eta, -1);
        assert_eq!(downloading.hash, format!("{:040x}", 7));
        assert_eq!(downloading.tags, vec!["remagnet"]);
        assert_eq!(downloading.category, "");
        assert_eq!(downloading.seeds, 3);
        assert_eq!(downloading.peers, 2);
        assert_eq!(downloading.download_speed, 10);
        assert_eq!(downloading.upload_speed, 5);
        assert_eq!(downloading.ratio, 1.5);

        let request = fake.request("torrent-get");
        let fields = request["arguments"]["fields"].as_array().unwrap();
        assert!(fields.contains(&json!("hashString")));
        assert!(fields.contains(&json!("labels")));
        assert!(request["arguments"].get("ids").is_none());
    }

    #[tokio::test]
    async fn gets_a_torrent_by_hash_or_reports_not_found() {
        let mut value = torrent("Example", 6, 0);
        value["hashString"] = json!(HASH);
        let fake = FakeTransmission::new(vec![value]);
        let server = start_fake(fake.clone()).await;
        let client = TransmissionClient::new(&config(&server.base_url, "")).unwrap();

        let found = client
            .get_torrent(&HASH.to_ascii_uppercase())
            .await
            .unwrap();
        let found = found.expect("the fake torrent should resolve");
        assert_eq!(found.name, "Example");
        assert_eq!(found.hash, HASH);

        let request = fake.request("torrent-get");
        assert_eq!(request["arguments"]["ids"], json!([HASH]));

        let missing = client
            .get_torrent("1111111111111111111111111111111111111111")
            .await
            .unwrap();
        assert!(missing.is_none());
    }

    #[tokio::test]
    async fn adds_torrents_with_labels_and_paused_state() {
        let fake = FakeTransmission::new(Vec::new());
        let server = start_fake(fake.clone()).await;
        let client = TransmissionClient::new(&config(&server.base_url, "")).unwrap();
        let magnet = format!("magnet:?xt=urn:btih:{HASH}&dn=Example");

        let result = client
            .add_torrent(
                std::slice::from_ref(&magnet),
                "",
                &["remagnet".to_string(), "nas".to_string()],
                true,
            )
            .await
            .unwrap();

        assert_eq!(result.added, 1);
        assert_eq!(result.hashes, vec![HASH.to_string()]);
        assert_eq!(result.category, "");
        assert_eq!(result.tags, vec!["remagnet", "nas"]);

        let request = fake.request("torrent-add");
        assert_eq!(request["arguments"]["filename"], magnet);
        assert_eq!(request["arguments"]["paused"], true);
        assert_eq!(request["arguments"]["labels"], json!(["remagnet", "nas"]));
    }

    #[tokio::test]
    async fn adds_a_category_as_a_label_when_no_tags_are_configured() {
        let fake = FakeTransmission::new(Vec::new());
        let server = start_fake(fake.clone()).await;
        let client = TransmissionClient::new(&config(&server.base_url, "")).unwrap();

        let result = client
            .add_torrent(
                &["magnet:?xt=urn:btih:ABC".to_string()],
                " films ",
                &[],
                false,
            )
            .await
            .unwrap();

        assert_eq!(result.tags, vec!["films"]);
        let request = fake.request("torrent-add");
        assert_eq!(request["arguments"]["labels"], json!(["films"]));
        assert_eq!(request["arguments"]["paused"], false);
    }

    #[tokio::test]
    async fn rejects_duplicates_and_falls_back_to_magnet_hashes() {
        let fake = FakeTransmission::new(Vec::new());
        {
            let mut state = fake.state.lock().unwrap();
            state.add_response = json!({
                "result": "success",
                "arguments": {
                    "torrent-duplicate": { "hashString": HASH, "name": "Example" }
                }
            });
        }
        let server = start_fake(fake.clone()).await;
        let client = TransmissionClient::new(&config(&server.base_url, "")).unwrap();

        let error = client
            .add_torrent(
                &[format!("magnet:?xt=urn:btih:{HASH}")],
                "remagnet",
                &[],
                false,
            )
            .await
            .unwrap_err();
        match error {
            AppError::BadRequest(message) => {
                assert_eq!(message, "Transmission already has this torrent.")
            }
            other => panic!("expected BadRequest, got {other:?}"),
        }

        let fake = FakeTransmission::new(Vec::new());
        {
            let mut state = fake.state.lock().unwrap();
            state.add_response = json!({ "result": "success", "arguments": {} });
        }
        let server = start_fake(fake.clone()).await;
        let client = TransmissionClient::new(&config(&server.base_url, "")).unwrap();
        let magnet = format!("magnet:?xt=urn:btih:{HASH}&dn=Example");
        let result = client.add_torrent(&[magnet], "", &[], false).await.unwrap();
        assert_eq!(result.hashes, vec![HASH.to_string()]);
    }

    #[tokio::test]
    async fn add_requires_at_least_one_url() {
        let fake = FakeTransmission::new(Vec::new());
        let server = start_fake(fake).await;
        let client = TransmissionClient::new(&config(&server.base_url, "")).unwrap();

        let error = client.add_torrent(&[], "", &[], false).await.unwrap_err();
        assert!(matches!(error, AppError::BadRequest(_)));
    }

    #[tokio::test]
    async fn removes_torrents_with_and_without_local_data() {
        let fake = FakeTransmission::new(Vec::new());
        let server = start_fake(fake.clone()).await;
        let client = TransmissionClient::new(&config(&server.base_url, "")).unwrap();

        client.remove_torrent(HASH, true).await.unwrap();
        client
            .remove_torrent(&HASH.to_ascii_uppercase(), false)
            .await
            .unwrap();

        let requests = fake
            .requests()
            .into_iter()
            .filter(|request| request["method"] == "torrent-remove")
            .collect::<Vec<_>>();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0]["arguments"]["ids"], json!([HASH]));
        assert_eq!(requests[0]["arguments"]["delete-local-data"], true);
        assert_eq!(requests[1]["arguments"]["ids"], json!([HASH]));
        assert_eq!(requests[1]["arguments"]["delete-local-data"], false);
    }

    #[tokio::test]
    async fn archives_a_torrent_with_its_download_directory() {
        let mut ready = torrent("Example", 6, 0);
        ready["hashString"] = json!(HASH);
        ready["percentDone"] = json!(1.0);
        ready["leftUntilDone"] = json!(0);
        let fake = FakeTransmission::new(vec![ready]);
        let server = start_fake(fake.clone()).await;
        let client = TransmissionClient::new(&config(&server.base_url, "")).unwrap();

        let archive = client.archive_torrent(HASH).await.unwrap();
        assert_eq!(archive.hash, HASH);
        assert_eq!(archive.name, "Example");
        assert_eq!(archive.progress, 1.0);
        assert_eq!(archive.amount_left, 0);
        assert_eq!(archive.state, "seeding");
        assert_eq!(archive.download_dir.as_deref(), Some("/downloads"));
        assert_eq!(archive.tags, vec!["remagnet"]);

        let request = fake.request("torrent-get");
        assert_eq!(request["arguments"]["ids"], json!([HASH]));
        assert!(request["arguments"]["fields"]
            .as_array()
            .unwrap()
            .contains(&json!("downloadDir")));

        let error = client
            .archive_torrent("1111111111111111111111111111111111111111")
            .await
            .unwrap_err();
        match error {
            AppError::NotFound(message) => assert_eq!(message, "Torrent not found."),
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn lists_wanted_files_with_their_progress() {
        let mut value = torrent("Example", 6, 0);
        value["hashString"] = json!(HASH);
        value["files"] = json!([
            { "name": "Example/readme.txt", "length": 10, "bytesCompleted": 10 },
            { "name": "Example/partial.bin", "length": 20, "bytesCompleted": 5 },
            { "name": "Example/empty.txt", "length": 0, "bytesCompleted": 0 },
            { "name": "Example/skipped.bin", "length": 30, "bytesCompleted": 30 }
        ]);
        value["fileStats"] = json!([
            { "wanted": true, "priority": 0 },
            { "wanted": true, "priority": 0 },
            { "wanted": true, "priority": 0 },
            { "wanted": false, "priority": 0 }
        ]);

        let fake = FakeTransmission::new(vec![value]);
        let server = start_fake(fake).await;
        let client = TransmissionClient::new(&config(&server.base_url, "")).unwrap();

        let files = client.files(HASH).await.unwrap();
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].index, 0);
        assert_eq!(files[0].name, "Example/readme.txt");
        assert_eq!(files[0].size, 10);
        assert_eq!(files[0].progress, 1.0);
        assert_eq!(files[1].index, 1);
        assert_eq!(files[1].progress, 0.25);
        assert_eq!(files[2].index, 2);
        assert_eq!(files[2].progress, 1.0);
    }

    #[tokio::test]
    async fn reports_rpc_errors_returned_in_the_body() {
        let fake = FakeTransmission::new(Vec::new());
        fake.state.lock().unwrap().result_override = Some("invalid argument".to_string());
        let server = start_fake(fake).await;
        let client = TransmissionClient::new(&config(&server.base_url, "")).unwrap();

        let error = client.test_connection().await.unwrap_err();
        match error {
            AppError::Upstream(message) => assert_eq!(
                message,
                "Transmission returned an error for session-get: invalid argument"
            ),
            other => panic!("expected Upstream, got {other:?}"),
        }
    }
}
