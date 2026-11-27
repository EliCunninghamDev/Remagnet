use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use futures_lite::StreamExt as _;
use reqwest::{header::REFERER, Method, Response, StatusCode};
use serde::{de::DeserializeOwned, Deserialize};
use tokio::sync::Mutex;

use crate::{
    backend::{
        build_http_client, extract_magnet_hashes, AddTorrentResult, ArchiveFile, ArchiveTorrent,
        BackendHealth, ClientKind, FileByteStream, TorrentCapabilities, TorrentFilePayload,
        TorrentSummary, VolumeMapper, AUTH_RETRY_ATTEMPTS,
    },
    config::Config,
    error::AppError,
};

/// Message for a torrent the client refused, for example because it exists.
const TORRENT_REJECTED: &str = "qBittorrent rejected the torrent. It may already exist, or the magnet link or .torrent file may be invalid.";

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
            hash: self.hash.to_ascii_lowercase(),
            name: self.name.clone(),
            state: normalize_state(&self.state),
            progress: self.progress.clamp(0.0, 1.0),
            size: self.size,
            download_speed: self.dlspeed,
            upload_speed: self.upspeed,
            eta: self.eta,
            ratio: self.ratio.max(0.0),
            category: self.category.clone(),
            tags: crate::config::parse_tags(&self.tags),
            seeds: self.num_seeds,
            peers: self.num_leechs,
        }
    }

    pub(crate) fn archive(&self) -> ArchiveTorrent {
        ArchiveTorrent {
            hash: self.hash.to_ascii_lowercase(),
            name: self.name.clone(),
            progress: self.progress.clamp(0.0, 1.0),
            amount_left: self.amount_left,
            state: normalize_state(&self.state),
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
    /// qBittorrent's file priority: `0` means the file is not wanted and must
    /// not be included in an archive.
    #[serde(default = "default_file_priority")]
    pub priority: i64,
}

fn default_file_priority() -> i64 {
    1
}

impl From<TorrentFile> for ArchiveFile {
    fn from(file: TorrentFile) -> Self {
        Self {
            index: file.index,
            name: file.name,
            size: file.size,
            progress: if file.size == 0 {
                1.0
            } else {
                file.progress.clamp(0.0, 1.0)
            },
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
        let http = build_http_client("qBittorrent", true)?;

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
                torrent_files: true,
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

    pub async fn archive_torrent(&self, hash: &str) -> Result<ArchiveTorrent, AppError> {
        Ok(self.torrent(hash).await?.archive())
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

        let category = category.trim();
        let tags = crate::config::normalize_tags(tags.iter().map(String::as_str));

        if !category.is_empty() {
            self.ensure_category(category).await?;
        }
        if !tags.is_empty() {
            self.ensure_tags(&tags).await?;
        }

        let mut form = Vec::new();
        if !urls.is_empty() {
            let urls = urls
                .iter()
                .map(|url| url.trim())
                .collect::<Vec<_>>()
                .join("\n");
            form.push(("urls".to_string(), urls));
        }
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

        let body = if files.is_empty() {
            self.post_form("api/v2/torrents/add", &form).await?
        } else {
            self.post_multipart("api/v2/torrents/add", &form, files)
                .await?
        };
        if body.trim().to_ascii_lowercase().starts_with("fail") {
            return Err(AppError::BadRequest(TORRENT_REJECTED.to_string()));
        }

        let mut hashes = extract_magnet_hashes(urls);
        hashes.extend(files.iter().map(|file| file.info_hash.clone()));

        Ok(AddTorrentResult {
            added: urls.len() + files.len(),
            hashes,
            category: category.to_string(),
            tags,
        })
    }

    pub async fn remove_torrent(&self, hash: &str, delete_files: bool) -> Result<(), AppError> {
        self.post_form(
            "api/v2/torrents/delete",
            &[
                ("hashes".to_string(), hash.to_ascii_lowercase()),
                ("deleteFiles".to_string(), delete_files.to_string()),
            ],
        )
        .await?;
        Ok(())
    }

    /// Pause the given torrents, doing nothing for an empty list.
    ///
    /// qBittorrent 5 renamed pause/resume to stop/start; older releases keep the
    /// original endpoints.
    pub async fn pause_torrents(&self, hashes: &[String]) -> Result<(), AppError> {
        if hashes.is_empty() {
            return Ok(());
        }

        let hashes = hashes
            .iter()
            .map(|hash| hash.to_ascii_lowercase())
            .collect::<Vec<_>>()
            .join("|");
        let form = [("hashes".to_string(), hashes)];
        self.post_form_with_fallback("api/v2/torrents/stop", "api/v2/torrents/pause", &form)
            .await
    }

    /// Resume the given torrents, doing nothing for an empty list.
    ///
    /// qBittorrent 5 renamed pause/resume to stop/start; older releases keep the
    /// original endpoints.
    pub async fn resume_torrents(&self, hashes: &[String]) -> Result<(), AppError> {
        if hashes.is_empty() {
            return Ok(());
        }

        let hashes = hashes
            .iter()
            .map(|hash| hash.to_ascii_lowercase())
            .collect::<Vec<_>>()
            .join("|");
        let form = [("hashes".to_string(), hashes)];
        self.post_form_with_fallback("api/v2/torrents/start", "api/v2/torrents/resume", &form)
            .await
    }

    /// List the files in a torrent, excluding files the user does not want.
    ///
    /// qBittorrent reports unwatched files with priority `0`; including them in
    /// an archive would fail because those bytes are never downloaded.
    pub async fn files(&self, hash: &str) -> Result<Vec<ArchiveFile>, AppError> {
        let hash = hash.to_ascii_lowercase();
        let files: Vec<TorrentFile> = self
            .get_json("api/v2/torrents/files", &[("hash", hash.as_str())])
            .await?;

        Ok(files
            .into_iter()
            .filter(|file| file.priority != 0)
            .map(ArchiveFile::from)
            .collect())
    }

    /// Open a single torrent file as a streaming response.
    pub async fn download_file(&self, hash: &str, file: &str) -> Result<Response, AppError> {
        self.ensure_login().await?;
        let hash = hash.to_ascii_lowercase();
        let response = self
            .send(
                Method::GET,
                "api/v2/torrents/downloadFile",
                &[("hash", hash.as_str()), ("file", file)],
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
        let hash = hash.to_ascii_lowercase();
        let torrents: Vec<TorrentInfo> = self
            .get_json("api/v2/torrents/info", &[("hashes", hash.as_str())])
            .await?;

        Ok(torrents
            .into_iter()
            .find(|torrent| torrent.hash.eq_ignore_ascii_case(&hash)))
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
            AppError::upstream_unreadable("qBittorrent")
        })
    }

    async fn get_text(&self, path: &str) -> Result<String, AppError> {
        self.ensure_login().await?;
        let response = self.send(Method::GET, path, &[]).await?;
        let response = ensure_success(response, path).await?;
        response.text().await.map_err(|error| {
            tracing::warn!(error = %error, path, "could not read qBittorrent response");
            AppError::upstream_unreadable("qBittorrent")
        })
    }

    async fn post_form(&self, path: &str, form: &[(String, String)]) -> Result<String, AppError> {
        self.ensure_login().await?;
        let response = self.request(Method::POST, path, &[], Some(form)).await?;
        let response = ensure_success(response, path).await?;
        response.text().await.map_err(|error| {
            tracing::warn!(error = %error, path, "could not read qBittorrent response");
            AppError::upstream_unreadable("qBittorrent")
        })
    }

    /// POST a form, retrying an older API path when the server returns 404.
    async fn post_form_with_fallback(
        &self,
        primary_path: &str,
        fallback_path: &str,
        form: &[(String, String)],
    ) -> Result<(), AppError> {
        self.ensure_login().await?;
        let response = self
            .request(Method::POST, primary_path, &[], Some(form))
            .await?;

        let (response, path) = if response.status() == StatusCode::NOT_FOUND {
            (
                self.request(Method::POST, fallback_path, &[], Some(form))
                    .await?,
                fallback_path,
            )
        } else {
            (response, primary_path)
        };

        ensure_success(response, path).await?;
        Ok(())
    }

    /// POST a `multipart/form-data` add request.
    ///
    /// `reqwest::multipart::Form` is consumed by `RequestBuilder::multipart`, so
    /// the form is rebuilt for every attempt; that keeps the 401/403 login retry
    /// working for uploaded `.torrent` files exactly like the form path.
    async fn post_multipart(
        &self,
        path: &str,
        fields: &[(String, String)],
        files: &[TorrentFilePayload],
    ) -> Result<String, AppError> {
        self.ensure_login().await?;

        let url = format!("{}/{}", self.base_url, path.trim_start_matches('/'));
        let referer = format!("{}/", self.base_url);

        for attempt in 0..AUTH_RETRY_ATTEMPTS {
            let mut form = reqwest::multipart::Form::new();
            for (name, value) in fields {
                form = form.text(name.clone(), value.clone());
            }
            for file in files {
                let part = reqwest::multipart::Part::bytes(file.bytes.clone())
                    .file_name(file.filename.clone())
                    .mime_str("application/x-bittorrent")
                    .map_err(AppError::internal)?;
                form = form.part("torrents", part);
            }

            let mut request = self
                .http
                .post(&url)
                .header(REFERER, &referer)
                .multipart(form);
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
            if retryable && attempt + 1 < AUTH_RETRY_ATTEMPTS {
                self.login(true).await?;
                continue;
            }

            let response = ensure_success(response, path).await?;
            return response.text().await.map_err(|error| {
                tracing::warn!(error = %error, path, "could not read qBittorrent response");
                AppError::upstream_unreadable("qBittorrent")
            });
        }

        unreachable!("the retry loop always returns")
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

        for attempt in 0..AUTH_RETRY_ATTEMPTS {
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
            if retryable && attempt + 1 < AUTH_RETRY_ATTEMPTS {
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

    // qBittorrent 5.x answers `409 Conflict` from `torrents/add` when every
    // submitted torrent already exists. That is a rejected request, not an
    // upstream failure.
    if status == StatusCode::CONFLICT && path.ends_with("torrents/add") {
        return Err(AppError::BadRequest(TORRENT_REJECTED.to_string()));
    }

    let body = response.text().await.unwrap_or_default();
    Err(AppError::upstream_status(
        "qBittorrent",
        status,
        path,
        &body,
    ))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use axum::{
        body::Body,
        extract::State,
        http::{header, Request},
        response::{IntoResponse, Response},
        Json, Router,
    };
    use http_body_util::BodyExt;

    use super::*;

    #[derive(Clone, Default)]
    struct CapturedAdd {
        content_type: Option<String>,
        body: Vec<u8>,
    }

    #[derive(Clone, Default)]
    struct FakeQbit {
        reject: bool,
        fail_add_once: bool,
        conflict_add: bool,
        legacy_actions: bool,
        logins: Arc<Mutex<Vec<String>>>,
        add_requests: Arc<Mutex<Vec<CapturedAdd>>>,
        add_attempts: Arc<Mutex<usize>>,
        action_requests: Arc<Mutex<Vec<(String, String)>>>,
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
            "/api/v2/torrents/categories" => Json(serde_json::json!({})).into_response(),
            "/api/v2/torrents/tags" => Json(serde_json::json!([])).into_response(),
            "/api/v2/torrents/files" => Json(serde_json::json!([
                { "index": 0, "name": "keep.mkv", "size": 10, "progress": 0.5, "priority": 1 },
                { "index": 1, "name": "skip.mkv", "size": 10, "progress": 0.5, "priority": 0 },
                { "index": 2, "name": "empty.nfo", "size": 0, "progress": 0.0 }
            ]))
            .into_response(),
            "/api/v2/torrents/createCategory" | "/api/v2/torrents/createTags" => "".into_response(),
            "/api/v2/torrents/add" => {
                let attempt = {
                    let mut attempts = fake.add_attempts.lock().unwrap();
                    *attempts += 1;
                    *attempts
                };
                if fake.fail_add_once && attempt == 1 {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                if fake.conflict_add {
                    return (StatusCode::CONFLICT, "Conflict").into_response();
                }

                let content_type = request
                    .headers()
                    .get(header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string);
                let body = request
                    .into_body()
                    .collect()
                    .await
                    .unwrap()
                    .to_bytes()
                    .to_vec();
                fake.add_requests
                    .lock()
                    .unwrap()
                    .push(CapturedAdd { content_type, body });
                "Ok.".into_response()
            }
            "/api/v2/torrents/stop"
            | "/api/v2/torrents/start"
            | "/api/v2/torrents/pause"
            | "/api/v2/torrents/resume" => {
                let body = request
                    .into_body()
                    .collect()
                    .await
                    .unwrap()
                    .to_bytes()
                    .to_vec();
                fake.action_requests
                    .lock()
                    .unwrap()
                    .push((path.clone(), String::from_utf8_lossy(&body).to_string()));

                let renamed = path.ends_with("/stop") || path.ends_with("/start");
                if fake.legacy_actions && renamed {
                    return StatusCode::NOT_FOUND.into_response();
                }
                "".into_response()
            }
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

    fn torrent_file(filename: &str, marker: &[u8]) -> TorrentFilePayload {
        use base64::{engine::general_purpose::STANDARD, Engine as _};

        TorrentFilePayload {
            filename: filename.to_string(),
            bytes: marker.to_vec(),
            base64: STANDARD.encode(marker),
            info_hash: "a".repeat(40),
        }
    }

    #[tokio::test]
    async fn uploads_torrent_files_as_multipart_with_defaults() {
        let fake = FakeQbit::default();
        let base_url = start_fake(fake.clone()).await;
        let client = QbitClient::new(&config(&base_url)).unwrap();
        let file = torrent_file("debian.torrent", b"d4:infod4:name4:testee");

        let result = client
            .add_torrent(
                &[],
                std::slice::from_ref(&file),
                "remagnet",
                &["remagnet".to_string(), "nas".to_string()],
                true,
            )
            .await
            .unwrap();

        assert_eq!(result.added, 1);
        assert_eq!(result.hashes, vec![file.info_hash.clone()]);
        assert_eq!(result.category, "remagnet");
        assert_eq!(result.tags, vec!["remagnet", "nas"]);

        let captured = fake.add_requests.lock().unwrap();
        assert_eq!(captured.len(), 1);
        let content_type = captured[0].content_type.as_deref().unwrap();
        assert!(
            content_type.starts_with("multipart/form-data; boundary="),
            "{content_type}"
        );

        let body = String::from_utf8_lossy(&captured[0].body);
        assert!(body.contains("name=\"torrents\"; filename=\"debian.torrent\""));
        assert!(body.contains("Content-Type: application/x-bittorrent"));
        assert!(body.contains("d4:infod4:name4:testee"));
        assert!(body.contains("name=\"category\""));
        assert!(body.contains("remagnet"));
        assert!(body.contains("name=\"tags\""));
        assert!(body.contains("remagnet,nas"));
        assert!(body.contains("name=\"paused\""));
        assert!(body.contains("name=\"stopped\""));
        assert!(!body.contains("name=\"urls\""));
    }

    #[tokio::test]
    async fn multipart_uploads_retry_after_a_401() {
        let fake = FakeQbit {
            fail_add_once: true,
            ..FakeQbit::default()
        };
        let base_url = start_fake(fake.clone()).await;
        let client = QbitClient::new(&config(&base_url)).unwrap();

        client
            .add_torrent(
                &[],
                &[torrent_file("debian.torrent", b"d4:infod4:name4:testee")],
                "",
                &[],
                false,
            )
            .await
            .unwrap();

        assert_eq!(*fake.add_attempts.lock().unwrap(), 2);
        assert_eq!(fake.logins.lock().unwrap().len(), 2);
        assert_eq!(fake.add_requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_duplicate_upload_is_reported_as_a_rejected_torrent() {
        let fake = FakeQbit {
            conflict_add: true,
            ..FakeQbit::default()
        };
        let base_url = start_fake(fake).await;
        let client = QbitClient::new(&config(&base_url)).unwrap();

        let error = client
            .add_torrent(
                &[],
                &[torrent_file("debian.torrent", b"d4:infod4:name4:testee")],
                "",
                &[],
                true,
            )
            .await
            .unwrap_err();

        assert!(matches!(error, AppError::BadRequest(_)), "{error:?}");
        assert!(error.to_string().contains("may already exist"));
    }

    #[tokio::test]
    async fn pauses_and_resumes_with_the_qbittorrent_5_endpoints() {
        let fake = FakeQbit::default();
        let base_url = start_fake(fake.clone()).await;
        let client = QbitClient::new(&config(&base_url)).unwrap();
        let hashes = vec!["ABCDEF".to_string(), "123456".to_string()];

        client.pause_torrents(&[]).await.unwrap();
        client.resume_torrents(&[]).await.unwrap();
        assert!(fake.action_requests.lock().unwrap().is_empty());

        client.pause_torrents(&hashes).await.unwrap();
        client.resume_torrents(&hashes).await.unwrap();

        let requests = fake.action_requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].0, "/api/v2/torrents/stop");
        assert_eq!(requests[0].1, "hashes=abcdef%7C123456");
        assert_eq!(requests[1].0, "/api/v2/torrents/start");
        assert_eq!(requests[1].1, "hashes=abcdef%7C123456");
    }

    #[tokio::test]
    async fn falls_back_to_pause_and_resume_on_qbittorrent_4() {
        let fake = FakeQbit {
            legacy_actions: true,
            ..FakeQbit::default()
        };
        let base_url = start_fake(fake.clone()).await;
        let client = QbitClient::new(&config(&base_url)).unwrap();
        let hashes = vec!["ABCDEF".to_string()];

        client.pause_torrents(&hashes).await.unwrap();
        client.resume_torrents(&hashes).await.unwrap();

        let requests = fake.action_requests.lock().unwrap();
        assert_eq!(requests.len(), 4);
        assert_eq!(requests[0].0, "/api/v2/torrents/stop");
        assert_eq!(requests[1].0, "/api/v2/torrents/pause");
        assert_eq!(requests[2].0, "/api/v2/torrents/start");
        assert_eq!(requests[3].0, "/api/v2/torrents/resume");
        assert!(requests.iter().all(|(_, body)| body == "hashes=abcdef"));
    }

    #[tokio::test]
    async fn files_with_priority_zero_are_skipped() {
        let fake = FakeQbit::default();
        let base_url = start_fake(fake).await;
        let client = QbitClient::new(&config(&base_url)).unwrap();

        let files = client.files(&"A".repeat(40)).await.unwrap();

        assert_eq!(files.len(), 2);
        assert_eq!(files[0].name, "keep.mkv");
        assert_eq!(files[0].progress, 0.5);
        // A missing priority defaults to wanted, and empty files count as done.
        assert_eq!(files[1].name, "empty.nfo");
        assert_eq!(files[1].progress, 1.0);
    }

    #[tokio::test]
    async fn rejects_an_add_without_urls_or_files() {
        let fake = FakeQbit::default();
        let base_url = start_fake(fake).await;
        let client = QbitClient::new(&config(&base_url)).unwrap();

        let error = client
            .add_torrent(&[], &[], "", &[], false)
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::BadRequest(_)), "{error:?}");
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
