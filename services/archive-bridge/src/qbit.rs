use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use anyhow::Context;
use reqwest::{Method, Response, StatusCode};
use serde::de::DeserializeOwned;
use tokio::sync::Mutex;

use crate::{config::Config, error::AppError};

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
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct TorrentInfo {
    pub hash: String,
    pub name: String,
    #[serde(default)]
    pub progress: f64,
    #[serde(default)]
    pub amount_left: u64,
    #[serde(default)]
    pub state: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct TorrentFile {
    #[serde(default)]
    pub index: i64,
    pub name: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub progress: f64,
}

impl QbitClient {
    pub fn new(config: &Config) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .cookie_store(true)
            .user_agent(concat!("remagnet-bridge/", env!("CARGO_PKG_VERSION")))
            // Archives can be many gigabytes and are streamed, so there is no
            // total request deadline. A read timeout still aborts stalls.
            .connect_timeout(std::time::Duration::from_secs(15))
            .read_timeout(std::time::Duration::from_secs(60))
            .build()
            .context("could not build the qBittorrent HTTP client")?;

        Ok(Self {
            base_url: config.qbit_base_url.clone(),
            api_key: (!config.qbit_api_key.is_empty()).then(|| config.qbit_api_key.clone()),
            username: (!config.qbit_username.is_empty()).then(|| config.qbit_username.clone()),
            password: config.qbit_password.clone(),
            http,
            logged_in: Arc::new(AtomicBool::new(false)),
            login_lock: Arc::new(Mutex::new(())),
        })
    }

    pub async fn test_connection(&self) -> Result<(String, String), AppError> {
        let app_version = self.get_text("api/v2/app/version").await?;
        let web_api_version = self.get_text("api/v2/app/webapiVersion").await?;
        Ok((
            app_version.trim().to_string(),
            web_api_version.trim().to_string(),
        ))
    }

    pub async fn torrent(&self, hash: &str) -> Result<TorrentInfo, AppError> {
        let torrents: Vec<TorrentInfo> = self
            .get_json("api/v2/torrents/info", &[("hashes", hash)])
            .await?;

        torrents
            .into_iter()
            .find(|torrent| torrent.hash.eq_ignore_ascii_case(hash))
            .ok_or_else(|| AppError::NotFound("Torrent not found in qBittorrent.".to_string()))
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
        ensure_success(response, "api/v2/torrents/downloadFile").await
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
            AppError::Upstream(format!("Could not parse qBittorrent JSON: {error}"))
        })
    }

    async fn get_text(&self, path: &str) -> Result<String, AppError> {
        self.ensure_login().await?;
        let response = self.send(Method::GET, path, &[]).await?;
        let response = ensure_success(response, path).await?;
        response.text().await.map_err(|error| {
            AppError::Upstream(format!("Could not read qBittorrent response: {error}"))
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
            .form(&[("username", username), ("password", &self.password)])
            .send()
            .await
            .map_err(|error| AppError::Upstream(format!("qBittorrent login failed: {error}")))?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() || !body.trim().eq_ignore_ascii_case("ok.") {
            self.logged_in.store(false, Ordering::Relaxed);
            return Err(AppError::Upstream(
                "qBittorrent rejected the saved username/password.".to_string(),
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
        let url = format!("{}/{}", self.base_url, path.trim_start_matches('/'));

        for attempt in 0..2 {
            let mut request = self.http.request(method.clone(), &url).query(query);
            if let Some(api_key) = &self.api_key {
                request = request.bearer_auth(api_key);
            }

            let response = request.send().await.map_err(|error| {
                AppError::Upstream(format!("qBittorrent request failed: {error}"))
            })?;

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

async fn ensure_success(response: Response, path: &str) -> Result<Response, AppError> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }

    let body = response.text().await.unwrap_or_default();
    let body = body.trim();
    let detail = if body.is_empty() {
        String::new()
    } else {
        format!(": {}", truncate(body, 300))
    };
    Err(AppError::Upstream(format!(
        "qBittorrent returned {status} for {path}{detail}"
    )))
}

fn truncate(value: &str, max_chars: usize) -> String {
    let mut truncated = value.chars().take(max_chars).collect::<String>();
    if value.chars().count() > max_chars {
        truncated.push('…');
    }
    truncated
}
