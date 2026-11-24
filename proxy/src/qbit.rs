use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use anyhow::Context;
use futures_lite::StreamExt as _;
use reqwest::{header::REFERER, Method, Response, StatusCode};
use serde::{de::DeserializeOwned, Deserialize};
use tokio::sync::Mutex;

use crate::{
    backend::{
        extract_magnet_hashes, AddTorrentResult, ArchiveFile, ArchiveTorrent, BackendHealth,
        ClientKind, FileByteStream, TorrentCapabilities, TorrentSummary, VolumeMapper,
    },
    config::Config,
    error::AppError,
};

/// Raw qBittorrent torrent fields used internally, including completion data
/// that the neutral API does not expose.
#[derive(Debug, Clone, Deserialize)]
pub struct TorrentInfo {
    pub hash: String,
    pub name: String,
    #[serde(default)]
    pub progress: f64,
    #[serde(default)]
    pub amount_left: u64,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub dlspeed: u64,
    #[serde(default)]
    pub upspeed: u64,
    #[serde(default)]
    pub eta: i64,
    #[serde(default)]
    pub ratio: f64,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub tags: String,
    #[serde(default)]
    pub num_seeds: u64,
    #[serde(default)]
    pub num_leechs: u64,
    #[serde(default)]
    pub save_path: String,
}

impl TorrentInfo {
    pub(crate) fn summary(&self) -> TorrentSummary {
        TorrentSummary {
            hash: self.hash.clone(),
            name: self.name.clone(),
            state: normalize_state(&self.state),
            progress: self.progress,
            size: self.size,
            download_speed: self.dlspeed,
            upload_speed: self.upspeed,
            eta: self.eta,
            ratio: self.ratio,
            category: self.category.clone(),
            tags: crate::config::parse_tags(&self.tags),
            seeds: self.num_seeds,
            peers: self.num_leechs,
        }
    }

    pub(crate) fn archive(&self) -> ArchiveTorrent {
        ArchiveTorrent {
            hash: self.hash.clone(),
            name: self.name.clone(),
            progress: self.progress,
            amount_left: self.amount_left,
            state: self.state.clone(),
            category: self.category.clone(),
            tags: crate::config::parse_tags(&self.tags),
            download_dir: (!self.save_path.trim().is_empty()).then(|| self.save_path.clone()),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct TorrentFile {
    #[serde(default)]
    pub index: i64,
    pub name: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub progress: f64,
}

impl From<TorrentFile> for ArchiveFile {
    fn from(file: TorrentFile) -> Self {
        Self {
            index: file.index,
            name: file.name,
            size: file.size,
            progress: file.progress,
        }
    }
}

/// Minimal qBittorrent Web API v2 client.
///
/// API keys are preferred and sent as a Bearer token. Username/password login
/// is supported as a fallback; the SID cookie is kept by reqwest's cookie jar.
#[derive(Clone)]
pub struct QbitClient {
    base_url: String,
    api_key: Option<String>,
    username: Option<String>,
    password: String,
    http: reqwest::Client,
    logged_in: Arc<AtomicBool>,
    login_lock: Arc<Mutex<()>>,
    volume: VolumeMapper,
}

impl QbitClient {
    pub fn new(config: &Config) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .cookie_store(true)
            .user_agent(concat!("remagnet-proxy/", env!("CARGO_PKG_VERSION")))
            // Archives can be many gigabytes and are streamed, so there is no
            // total request deadline. A read timeout still aborts stalls.
            .connect_timeout(std::time::Duration::from_secs(15))
            .read_timeout(std::time::Duration::from_secs(60))
            .build()
            .context("could not build the qBittorrent HTTP client")?;

        Ok(Self {
            base_url: config.base_url.clone(),
            api_key: (!config.api_key.is_empty()).then(|| config.api_key.clone()),
            username: (!config.username.is_empty()).then(|| config.username.clone()),
            password: config.password.clone(),
            http,
            logged_in: Arc::new(AtomicBool::new(false)),
            login_lock: Arc::new(Mutex::new(())),
            volume: VolumeMapper::from_config(config),
        })
    }

    pub async fn test_connection(&self) -> Result<BackendHealth, AppError> {
        let app_version = self.get_text("api/v2/app/version").await?;
        let web_api_version = self.get_text("api/v2/app/webapiVersion").await?;
        Ok(BackendHealth {
            client_label: ClientKind::Qbittorrent.label().to_string(),
            app_version: app_version.trim().to_string(),
            web_api_version: web_api_version.trim().to_string(),
            capabilities: TorrentCapabilities {
                pause_on_add: true,
                archive_download: true,
                categories: true,
                tags: true,
            },
        })
    }

    pub async fn list_torrents(&self) -> Result<Vec<TorrentSummary>, AppError> {
        let torrents: Vec<TorrentInfo> = self
            .get_json(
                "api/v2/torrents/info",
                &[("sort", "added_on"), ("reverse", "true")],
            )
            .await?;
        Ok(torrents.iter().map(TorrentInfo::summary).collect())
    }

    /// Fetch a torrent without applying the proxy's category/tag filter.
    ///
    /// Duplicate checks must see every torrent in the client, including ones
    /// that were added elsewhere and are not owned by Remagnet.
    pub async fn get_torrent(&self, hash: &str) -> Result<Option<TorrentSummary>, AppError> {
        Ok(self
            .get_torrent_info(hash)
            .await?
            .map(|torrent| torrent.summary()))
    }

    pub async fn torrent(&self, hash: &str) -> Result<TorrentInfo, AppError> {
        self.get_torrent_info(hash)
            .await?
            .ok_or_else(|| AppError::NotFound("Torrent not found in qBittorrent.".to_string()))
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
        let tags = crate::config::normalize_tags(tags.iter().map(String::as_str));

        if !category.is_empty() {
            self.ensure_category(category).await?;
        }
        if !tags.is_empty() {
            self.ensure_tags(&tags).await?;
        }

        let mut form = vec![("urls".to_string(), urls.join("\n"))];
        if !category.is_empty() {
            form.push(("category".to_string(), category.to_string()));
        }
        if !tags.is_empty() {
            form.push(("tags".to_string(), tags.join(",")));
        }
        if paused {
            // qBittorrent 5 reads "stopped" and older versions read "paused".
            form.push(("paused".to_string(), "true".to_string()));
            form.push(("stopped".to_string(), "true".to_string()));
        }

        let body = self.post_form("api/v2/torrents/add", &form).await?;
        if body.trim().to_ascii_lowercase().starts_with("fail") {
            return Err(AppError::BadRequest(
                "qBittorrent rejected the torrent. It may already exist, or the magnet link may be invalid."
                    .to_string(),
            ));
        }

        Ok(AddTorrentResult {
            added: urls.len(),
            hashes: extract_magnet_hashes(urls),
            category: category.to_string(),
            tags,
        })
    }

    pub async fn remove_torrent(&self, hash: &str, delete_files: bool) -> Result<(), AppError> {
        self.post_form(
            "api/v2/torrents/delete",
            &[
                ("hashes".to_string(), hash.to_string()),
                ("deleteFiles".to_string(), delete_files.to_string()),
            ],
        )
        .await?;
        Ok(())
    }

    pub async fn files(&self, hash: &str) -> Result<Vec<TorrentFile>, AppError> {
        self.get_json("api/v2/torrents/files", &[("hash", hash)])
            .await
    }

    /// Open a single torrent file as a streaming response.
    pub async fn download_file(&self, hash: &str, file: &str) -> Result<Response, AppError> {
        self.ensure_login().await?;
        let response = self
            .send(
                Method::GET,
                "api/v2/torrents/downloadFile",
                &[("hash", hash), ("file", file)],
            )
            .await?;
        if matches!(
            response.status(),
            StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED
        ) {
            return Err(AppError::NotFound(format!(
                "qBittorrent does not expose {file} for download."
            )));
        }
        ensure_success(response, "api/v2/torrents/downloadFile").await
    }

    /// Stream one torrent file, preferring the qBittorrent HTTP endpoint.
    ///
    /// qBittorrent 5.x serves `torrents/downloadFile` directly. Older releases
    /// return 404; when a read-only downloads volume is configured, the file is
    /// read from the mounted volume instead.
    pub async fn open_file(
        &self,
        torrent: &ArchiveTorrent,
        file: &ArchiveFile,
    ) -> Result<FileByteStream, AppError> {
        match self.download_file(&torrent.hash, &file.name).await {
            Ok(response) => {
                let stream = response
                    .bytes_stream()
                    .map(|result| result.map_err(std::io::Error::other));
                Ok(Box::pin(stream))
            }
            Err(AppError::NotFound(_)) if self.volume.is_configured() => {
                self.volume
                    .open_file(torrent.download_dir.as_deref(), &file.name)
                    .await
            }
            Err(error) => Err(error),
        }
    }

    async fn get_torrent_info(&self, hash: &str) -> Result<Option<TorrentInfo>, AppError> {
        let torrents: Vec<TorrentInfo> = self
            .get_json("api/v2/torrents/info", &[("hashes", hash)])
            .await?;

        Ok(torrents
            .into_iter()
            .find(|torrent| torrent.hash.eq_ignore_ascii_case(hash)))
    }

    async fn ensure_category(&self, name: &str) -> Result<(), AppError> {
        if self.categories().await?.contains_key(name) {
            return Ok(());
        }

        let form = [
            ("category".to_string(), name.to_string()),
            ("savePath".to_string(), String::new()),
        ];
        match self
            .post_form("api/v2/torrents/createCategory", &form)
            .await
        {
            Ok(_) => Ok(()),
            Err(error) => {
                // A concurrent add may have created it between the check and
                // the request, which is a success from this client's point of
                // view.
                if self.categories().await?.contains_key(name) {
                    Ok(())
                } else {
                    Err(error)
                }
            }
        }
    }

    async fn ensure_tags(&self, tags: &[String]) -> Result<(), AppError> {
        let existing = self.tags().await?;
        let missing = tags
            .iter()
            .filter(|tag| !existing.contains(tag))
            .cloned()
            .collect::<Vec<_>>();
        if missing.is_empty() {
            return Ok(());
        }

        let form = [("tags".to_string(), missing.join(","))];
        match self.post_form("api/v2/torrents/createTags", &form).await {
            Ok(_) => Ok(()),
            Err(error) => {
                let refreshed = self.tags().await?;
                if missing.iter().any(|tag| !refreshed.contains(tag)) {
                    Err(error)
                } else {
                    Ok(())
                }
            }
        }
    }

    async fn categories(&self) -> Result<HashMap<String, serde_json::Value>, AppError> {
        self.get_json("api/v2/torrents/categories", &[]).await
    }

    async fn tags(&self) -> Result<Vec<String>, AppError> {
        self.get_json("api/v2/torrents/tags", &[]).await
    }

    async fn get_json<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<T, AppError> {
        self.ensure_login().await?;
        let response = self.send(Method::GET, path, query).await?;
        let response = ensure_success(response, path).await?;
        response.json().await.map_err(|error| {
            tracing::warn!(error = %error, path, "could not parse qBittorrent JSON");
            AppError::Upstream(
                "qBittorrent returned a response Remagnet Proxy could not read. Check that qBittorrent is running and up to date."
                    .to_string(),
            )
        })
    }

    async fn get_text(&self, path: &str) -> Result<String, AppError> {
        self.ensure_login().await?;
        let response = self.send(Method::GET, path, &[]).await?;
        let response = ensure_success(response, path).await?;
        response.text().await.map_err(|error| {
            tracing::warn!(error = %error, path, "could not read qBittorrent response");
            AppError::Upstream(
                "Remagnet Proxy could not read qBittorrent's response. Check that it is running and reachable."
                    .to_string(),
            )
        })
    }

    async fn post_form(&self, path: &str, form: &[(String, String)]) -> Result<String, AppError> {
        self.ensure_login().await?;
        let response = self.request(Method::POST, path, &[], Some(form)).await?;
        let response = ensure_success(response, path).await?;
        response.text().await.map_err(|error| {
            tracing::warn!(error = %error, path, "could not read qBittorrent response");
            AppError::Upstream(
                "Remagnet Proxy could not read qBittorrent's response. Check that it is running and reachable."
                    .to_string(),
            )
        })
    }

    async fn ensure_login(&self) -> Result<(), AppError> {
        if self.api_key.is_some() || self.logged_in.load(Ordering::Relaxed) {
            return Ok(());
        }
        self.login(false).await
    }

    async fn login(&self, force: bool) -> Result<(), AppError> {
        if self.api_key.is_some() {
            return Ok(());
        }

        let _guard = self.login_lock.lock().await;
        if !force && self.logged_in.load(Ordering::Relaxed) {
            return Ok(());
        }

        let username = self.username.as_deref().ok_or_else(|| {
            AppError::Upstream("No qBittorrent API key or username is configured.".to_string())
        })?;

        let url = format!("{}/api/v2/auth/login", self.base_url);
        let response = self
            .http
            .post(url)
            .header(REFERER, format!("{}/", self.base_url))
            .form(&[("username", username), ("password", &self.password)])
            .send()
            .await
            .map_err(|error| AppError::from_reqwest("qBittorrent", error))?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let body = body.trim();
        // qBittorrent 4.x answers 200 "Ok."; 5.3 answers 204 with no body.
        if !status.is_success() || !(body.is_empty() || body.eq_ignore_ascii_case("ok.")) {
            self.logged_in.store(false, Ordering::Relaxed);
            return Err(AppError::UpstreamAuth(
                "qBittorrent rejected the saved credentials. Update the API key or login in the Remagnet Proxy page."
                    .to_string(),
            ));
        }

        self.logged_in.store(true, Ordering::Relaxed);
        Ok(())
    }

    async fn send(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<Response, AppError> {
        self.request(method, path, query, None).await
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
        form: Option<&[(String, String)]>,
    ) -> Result<Response, AppError> {
        let url = format!("{}/{}", self.base_url, path.trim_start_matches('/'));
        let referer = format!("{}/", self.base_url);

        for attempt in 0..2 {
            let mut request = self
                .http
                .request(method.clone(), &url)
                .query(query)
                .header(REFERER, &referer);
            if let Some(form) = form {
                request = request.form(form);
            }
            if let Some(api_key) = &self.api_key {
                request = request.bearer_auth(api_key);
            }

            let response = request
                .send()
                .await
                .map_err(|error| AppError::from_reqwest("qBittorrent", error))?;

            let retryable = self.api_key.is_none()
                && matches!(
                    response.status(),
                    StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
                );
            if retryable && attempt == 0 {
                self.login(true).await?;
                continue;
            }

            return Ok(response);
        }

        unreachable!("the retry loop always returns")
    }
}

/// Collapse a qBittorrent state into the client-neutral set.
pub fn normalize_state(state: &str) -> String {
    match state {
        "allocating" | "checkingDL" | "checkingResumeData" | "checkingUP" => "checking",
        "downloading" | "forcedDL" => "downloading",
        "metaDL" => "metadata",
        "stalledDL" => "stalled",
        "queuedDL" | "queuedUP" => "queued",
        "moving" => "moving",
        "uploading" | "forcedUP" | "stalledUP" => "seeding",
        "pausedDL" | "pausedUP" | "stoppedDL" | "stoppedUP" => "stopped",
        "error" => "error",
        "missingFiles" => "missingFiles",
        "unknown" => "unknown",
        other => other,
    }
    .to_string()
}

async fn ensure_success(response: Response, path: &str) -> Result<Response, AppError> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }

    if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
        return Err(AppError::UpstreamAuth(
            "qBittorrent rejected the saved credentials. Update the API key or login in the Remagnet Proxy page."
                .to_string(),
        ));
    }

    let body = response.text().await.unwrap_or_default();
    let detail = AppError::sanitize_upstream_body(&body, 300)
        .map(|detail| format!(": {detail}"))
        .unwrap_or_default();
    Err(AppError::Upstream(format!(
        "qBittorrent returned {status} for {path}{detail}"
    )))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use axum::{
        body::Body,
        extract::State,
        http::{header, Request},
        response::{IntoResponse, Response},
        Router,
    };
    use http_body_util::BodyExt;

    use super::*;

    #[derive(Clone, Default)]
    struct FakeQbit {
        reject: bool,
        logins: Arc<Mutex<Vec<String>>>,
    }

    async fn fake_qbit(State(fake): State<FakeQbit>, request: Request<Body>) -> Response {
        let path = request.uri().path().to_string();
        if path == "/api/v2/auth/login" {
            let body = request.into_body().collect().await.unwrap().to_bytes();
            fake.logins
                .lock()
                .unwrap()
                .push(String::from_utf8_lossy(&body).to_string());
            if fake.reject {
                return (StatusCode::OK, "Fails.").into_response();
            }
            // qBittorrent 5.3: 204, no body, session cookie.
            return (
                StatusCode::NO_CONTENT,
                [(header::SET_COOKIE, "SID=authenticated; path=/")],
            )
                .into_response();
        }

        let authenticated = request
            .headers()
            .get(header::COOKIE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.contains("SID=authenticated"));
        if !authenticated {
            return StatusCode::UNAUTHORIZED.into_response();
        }

        match path.as_str() {
            "/api/v2/app/version" => "v5.3.0".into_response(),
            "/api/v2/app/webapiVersion" => "2.11.0".into_response(),
            _ => StatusCode::NOT_FOUND.into_response(),
        }
    }

    async fn start_fake(fake: FakeQbit) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().fallback(fake_qbit).with_state(fake);
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{address}")
    }

    fn config(base_url: &str) -> Config {
        Config {
            client_kind: ClientKind::Qbittorrent,
            base_url: base_url.to_string(),
            api_key: String::new(),
            username: "admin".to_string(),
            password: "adminadmin".to_string(),
            downloads_dir: String::new(),
            client_downloads_dir: String::new(),
            default_category: "remagnet".to_string(),
            default_tags: vec!["remagnet".to_string()],
        }
    }

    #[tokio::test]
    async fn accepts_the_empty_204_login_from_qbittorrent_5() {
        let fake = FakeQbit::default();
        let base_url = start_fake(fake.clone()).await;
        let client = QbitClient::new(&config(&base_url)).unwrap();

        let health = client.test_connection().await.unwrap();
        assert_eq!(health.app_version, "v5.3.0");
        assert_eq!(health.web_api_version, "2.11.0");

        let logins = fake.logins.lock().unwrap().clone();
        assert_eq!(logins.len(), 1);
        assert!(logins[0].contains("username=admin"));
        assert!(logins[0].contains("password=adminadmin"));
    }

    #[tokio::test]
    async fn rejects_a_login_body_that_reports_failure() {
        let fake = FakeQbit {
            reject: true,
            ..FakeQbit::default()
        };
        let base_url = start_fake(fake).await;
        let client = QbitClient::new(&config(&base_url)).unwrap();

        let error = client.test_connection().await.unwrap_err();
        match error {
            AppError::UpstreamAuth(message) => assert_eq!(
                message,
                "qBittorrent rejected the saved credentials. Update the API key or login in the Remagnet Proxy page."
            ),
            other => panic!("expected UpstreamAuth, got {other:?}"),
        }
    }

    #[test]
    fn normalizes_every_known_qbittorrent_state() {
        let cases = [
            ("allocating", "checking"),
            ("checkingDL", "checking"),
            ("checkingResumeData", "checking"),
            ("checkingUP", "checking"),
            ("downloading", "downloading"),
            ("forcedDL", "downloading"),
            ("metaDL", "metadata"),
            ("stalledDL", "stalled"),
            ("queuedDL", "queued"),
            ("queuedUP", "queued"),
            ("moving", "moving"),
            ("uploading", "seeding"),
            ("forcedUP", "seeding"),
            ("stalledUP", "seeding"),
            ("pausedDL", "stopped"),
            ("pausedUP", "stopped"),
            ("stoppedDL", "stopped"),
            ("stoppedUP", "stopped"),
            ("error", "error"),
            ("missingFiles", "missingFiles"),
            ("unknown", "unknown"),
        ];

        for (raw, expected) in cases {
            assert_eq!(normalize_state(raw), expected);
        }
        assert_eq!(normalize_state("futureState"), "futureState");
    }
}
