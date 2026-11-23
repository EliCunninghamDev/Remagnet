use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use anyhow::Context;
use reqwest::{header::REFERER, Method, Response, StatusCode};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tokio::sync::Mutex;
use url::Url;

use crate::{config::Config, error::AppError};

/// A torrent in the client-neutral shape shared by the extension and Android.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentSummary {
    pub hash: String,
    pub name: String,
    pub state: String,
    pub progress: f64,
    pub size: u64,
    pub download_speed: u64,
    pub upload_speed: u64,
    pub eta: i64,
    pub ratio: f64,
    pub category: String,
    pub tags: Vec<String>,
    pub seeds: u64,
    pub peers: u64,
}

/// Features the proxy exposes for the torrent client it adapts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentCapabilities {
    pub pause_on_add: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentList {
    pub torrents: Vec<TorrentSummary>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddTorrentRequest {
    pub urls: Vec<String>,
    #[serde(default)]
    pub paused: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddTorrentResult {
    pub added: usize,
    pub hashes: Vec<String>,
    pub category: String,
    pub tags: Vec<String>,
}

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
}

impl TorrentInfo {
    fn summary(&self) -> TorrentSummary {
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
            hashes: info_hashes(urls),
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
        ensure_success(response, "api/v2/torrents/downloadFile").await
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

    async fn post_form(&self, path: &str, form: &[(String, String)]) -> Result<String, AppError> {
        self.ensure_login().await?;
        let response = self.request(Method::POST, path, &[], Some(form)).await?;
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
            .header(REFERER, format!("{}/", self.base_url))
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

/// Whether a torrent is owned by Remagnet under the configured defaults.
///
/// Category and tag matching is case-insensitive, mirroring qBittorrent and the
/// extension's relevance filter. When both defaults are empty, every torrent
/// matches.
pub fn matches_torrent_filter(
    torrent: &TorrentSummary,
    default_category: &str,
    default_tags: &[String],
) -> bool {
    let category = default_category.trim();
    let tags = default_tags
        .iter()
        .map(|tag| tag.trim())
        .filter(|tag| !tag.is_empty())
        .collect::<Vec<_>>();

    if category.is_empty() && tags.is_empty() {
        return true;
    }

    if !category.is_empty() && fold(&torrent.category) == fold(category) {
        return true;
    }

    let torrent_tags = torrent
        .tags
        .iter()
        .map(|tag| fold(tag))
        .collect::<HashSet<_>>();
    tags.iter().any(|tag| torrent_tags.contains(&fold(tag)))
}

/// Extract the v1/v2 info hashes embedded in `magnet:` URLs.
pub fn info_hashes(urls: &[String]) -> Vec<String> {
    urls.iter().filter_map(|url| info_hash(url)).collect()
}

fn info_hash(url: &str) -> Option<String> {
    let parsed = Url::parse(url.trim()).ok()?;
    if !parsed.scheme().eq_ignore_ascii_case("magnet") {
        return None;
    }

    let mut btih = None;
    let mut btmh = None;
    for (key, value) in parsed.query_pairs() {
        if !key.eq_ignore_ascii_case("xt") {
            continue;
        }

        let value = value.trim().to_ascii_lowercase();
        if let Some(hash) = value.strip_prefix("urn:btih:") {
            if btih.is_none() {
                btih = parse_btih(hash);
            }
        } else if let Some(hash) = value.strip_prefix("urn:btmh:") {
            if btmh.is_none() {
                btmh = parse_btmh(hash);
            }
        }
    }

    btih.or(btmh)
}

fn parse_btih(hash: &str) -> Option<String> {
    if hash.len() == 40 && is_hex(hash) {
        return Some(hash.to_string());
    }
    if hash.len() == 32 {
        return base32_to_hex(hash);
    }
    None
}

fn parse_btmh(hash: &str) -> Option<String> {
    let hash = hash
        .strip_prefix("1220")
        .filter(|rest| rest.len() == 64)
        .unwrap_or(hash);
    (hash.len() == 64 && is_hex(hash)).then(|| hash.to_string())
}

fn is_hex(value: &str) -> bool {
    value.chars().all(|character| character.is_ascii_hexdigit())
}

fn base32_to_hex(value: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(20);
    let mut buffer = 0u32;
    let mut bits = 0u32;

    for character in value.chars() {
        let digit = match character.to_ascii_uppercase() {
            'A'..='Z' => character.to_ascii_uppercase() as u32 - 'A' as u32,
            '2'..='7' => character as u32 - '2' as u32 + 26,
            _ => return None,
        };
        buffer = (buffer << 5) | digit;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            bytes.push((buffer >> bits) as u8);
            buffer &= if bits == 0 { 0 } else { (1 << bits) - 1 };
        }
    }

    if bytes.len() != 20 {
        return None;
    }

    Some(
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>(),
    )
}

fn fold(value: &str) -> String {
    value.trim().to_lowercase()
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

#[cfg(test)]
mod tests {
    use super::*;

    fn torrent(category: &str, tags: &[&str]) -> TorrentSummary {
        TorrentSummary {
            hash: "a".repeat(40),
            name: "Example".to_string(),
            state: "seeding".to_string(),
            progress: 1.0,
            size: 10,
            download_speed: 0,
            upload_speed: 0,
            eta: 0,
            ratio: 1.0,
            category: category.to_string(),
            tags: tags.iter().map(|tag| tag.to_string()).collect(),
            seeds: 1,
            peers: 1,
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

    #[test]
    fn filters_by_category_or_tag_ignoring_case() {
        let category = "Remagnet";
        let tags = vec!["Nas".to_string()];
        assert!(matches_torrent_filter(
            &torrent("remagnet", &[]),
            category,
            &tags
        ));
        assert!(matches_torrent_filter(
            &torrent("films", &["nas"]),
            category,
            &tags
        ));
        assert!(!matches_torrent_filter(
            &torrent("films", &["other"]),
            category,
            &tags
        ));
    }

    #[test]
    fn empty_defaults_accept_every_torrent() {
        assert!(matches_torrent_filter(&torrent("films", &[]), "", &[]));
        assert!(matches_torrent_filter(
            &torrent("", &[]),
            "  ",
            &["  ".to_string()]
        ));
    }

    #[test]
    fn extracts_v1_and_v2_hashes_from_magnets() {
        let hex = "0123456789abcdef0123456789abcdef01234567";
        let v2 = "0123456789abcdef".repeat(4);
        let urls = vec![
            format!("magnet:?xt=urn:btih:{hex}&dn=test"),
            format!("magnet:?xt=urn:btih:{}", hex.to_uppercase()),
            "magnet:?xt=urn:btih:AERUKZ4JVPG66AJDIVTYTK6N54ASGRLH".to_string(),
            format!("magnet:?xt=urn:btmh:1220{v2}"),
            "https://example.com/file.torrent".to_string(),
        ];

        assert_eq!(
            info_hashes(&urls),
            vec![hex.to_string(), hex.to_string(), hex.to_string(), v2,]
        );
    }
}
