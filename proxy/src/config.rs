use std::{
    collections::HashSet,
    env,
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::backend::ClientKind;

pub const DEFAULT_QBIT_BASE_URL: &str = "http://gluetun:8080";
pub const DEFAULT_TRANSMISSION_BASE_URL: &str = "http://transmission:9091";

fn default_category() -> String {
    "remagnet".to_string()
}

fn default_tags() -> Vec<String> {
    vec!["remagnet".to_string()]
}

/// Settings persisted in `DATA_DIR/config.json`.
///
/// Administrator credentials and per-device token hashes live in `auth.json`
/// instead, so this file holds only the torrent client connection and the
/// magnet defaults returned by the config API.
///
/// Field names are client-neutral; the `qbit*` aliases keep configuration files
/// written by earlier versions readable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default)]
    pub client_kind: ClientKind,
    #[serde(alias = "qbitBaseUrl")]
    pub base_url: String,
    #[serde(default, alias = "qbitApiKey")]
    pub api_key: String,
    #[serde(default, alias = "qbitUsername")]
    pub username: String,
    #[serde(default, alias = "qbitPassword")]
    pub password: String,
    #[serde(default)]
    pub downloads_dir: String,
    #[serde(default)]
    pub client_downloads_dir: String,
    #[serde(default = "default_category")]
    pub default_category: String,
    #[serde(default = "default_tags")]
    pub default_tags: Vec<String>,
}

/// Bootstrap values read from the environment when no config file exists yet.
pub struct ConfigEnv {
    pub client_kind: ClientKind,
    pub base_url: String,
    pub api_key: String,
    pub username: String,
    pub password: String,
    pub downloads_dir: String,
    pub client_downloads_dir: String,
    pub default_category: String,
    pub default_tags: Vec<String>,
}

impl ConfigEnv {
    pub fn from_env() -> Self {
        let default_category = env::var("REMAGNET_CATEGORY")
            .map(|value| value.trim().to_string())
            .unwrap_or_else(|_| default_category());
        let default_tags = env::var("REMAGNET_TAGS")
            .map(|value| parse_tags(&value))
            .unwrap_or_else(|_| default_tags());

        let client_kind = env_non_empty("CLIENT_KIND")
            .and_then(|value| ClientKind::from_str_loose(&value))
            .unwrap_or_default();

        Self {
            client_kind,
            base_url: resolve_default_base_url(
                client_kind,
                env_non_empty("CLIENT_BASE_URL")
                    .or_else(|| env_non_empty("QBIT_BASE_URL"))
                    .or_else(|| env_non_empty("TRANSMISSION_BASE_URL")),
            ),
            api_key: env::var("QBIT_API_KEY").unwrap_or_default(),
            username: env_non_empty("CLIENT_USERNAME")
                .or_else(|| env::var("QBIT_USERNAME").ok())
                .unwrap_or_default(),
            password: env_non_empty("CLIENT_PASSWORD")
                .or_else(|| env::var("QBIT_PASSWORD").ok())
                .unwrap_or_default(),
            downloads_dir: env::var("DOWNLOADS_DIR").unwrap_or_default(),
            client_downloads_dir: env::var("CLIENT_DOWNLOADS_DIR").unwrap_or_default(),
            default_category,
            default_tags,
        }
    }
}

fn env_non_empty(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.trim().is_empty())
}

/// Pick the bootstrap URL for the configured client kind.
///
/// Transmission often runs without authentication on a private network, so its
/// default is used whenever no explicit URL was supplied.
fn resolve_default_base_url(client_kind: ClientKind, explicit: Option<String>) -> String {
    explicit.unwrap_or_else(|| match client_kind {
        ClientKind::Qbittorrent => DEFAULT_QBIT_BASE_URL.to_string(),
        ClientKind::Transmission => DEFAULT_TRANSMISSION_BASE_URL.to_string(),
    })
}

/// Fields the config page may change.
///
/// `None` means "keep the saved value". `Some("")` clears a secret. The page
/// never receives existing secret values back.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigUpdate {
    #[serde(default)]
    pub client_kind: Option<ClientKind>,
    #[serde(alias = "qbitBaseUrl")]
    pub base_url: String,
    #[serde(default, alias = "qbitApiKey")]
    pub api_key: Option<String>,
    #[serde(default, alias = "qbitUsername")]
    pub username: Option<String>,
    #[serde(default, alias = "qbitPassword")]
    pub password: Option<String>,
    #[serde(default)]
    pub downloads_dir: Option<String>,
    #[serde(default)]
    pub client_downloads_dir: Option<String>,
    #[serde(default)]
    pub default_category: Option<String>,
    #[serde(default)]
    pub default_tags: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicConfig {
    pub client_kind: ClientKind,
    pub base_url: String,
    /// Kept for the Step 1 page and older clients; the same value as `baseUrl`.
    pub qbit_base_url: String,
    pub username: String,
    /// Kept for the Step 1 page and older clients; the same value as `username`.
    pub qbit_username: String,
    pub has_api_key: bool,
    pub has_password: bool,
    pub downloads_dir: String,
    pub client_downloads_dir: String,
    pub default_category: String,
    pub default_tags: Vec<String>,
}

impl From<&Config> for PublicConfig {
    fn from(config: &Config) -> Self {
        Self {
            client_kind: config.client_kind,
            base_url: config.base_url.clone(),
            qbit_base_url: config.base_url.clone(),
            username: config.username.clone(),
            qbit_username: config.username.clone(),
            has_api_key: !config.api_key.is_empty(),
            has_password: !config.password.is_empty(),
            downloads_dir: config.downloads_dir.clone(),
            client_downloads_dir: config.client_downloads_dir.clone(),
            default_category: config.default_category.clone(),
            default_tags: config.default_tags.clone(),
        }
    }
}

impl Config {
    pub fn from_env(env: ConfigEnv) -> Result<Self> {
        let config = Self {
            client_kind: env.client_kind,
            base_url: normalize_base_url(&env.base_url).map_err(anyhow::Error::msg)?,
            api_key: env.api_key.trim().to_string(),
            username: env.username.trim().to_string(),
            password: env.password,
            downloads_dir: env.downloads_dir.trim().to_string(),
            client_downloads_dir: env.client_downloads_dir.trim().to_string(),
            default_category: env.default_category.trim().to_string(),
            default_tags: normalize_tags(env.default_tags),
        };
        config.validate()?;
        Ok(config)
    }

    /// Whether enough credentials are saved to build a torrent client.
    ///
    /// A proxy without credentials still boots and serves its config page; only
    /// the torrent endpoints report that setup is incomplete. Transmission's
    /// RPC endpoint frequently has no authentication at all, so a URL is the
    /// only requirement for it.
    pub fn has_credentials(&self) -> bool {
        match self.client_kind {
            ClientKind::Qbittorrent => !self.api_key.is_empty() || !self.username.is_empty(),
            ClientKind::Transmission => !self.base_url.is_empty(),
        }
    }

    pub fn validate(&self) -> Result<()> {
        let normalized = normalize_base_url(&self.base_url).map_err(anyhow::Error::msg)?;
        if normalized != self.base_url {
            bail!("Torrent client base URL is not normalized: {normalized}");
        }
        Ok(())
    }

    pub fn apply_update(&mut self, update: ConfigUpdate) -> std::result::Result<(), String> {
        let base_url = normalize_base_url(&update.base_url)?;

        if let Some(kind) = update.client_kind {
            self.client_kind = kind;
        }
        if let Some(api_key) = update.api_key {
            self.api_key = api_key.trim().to_string();
        }
        if let Some(username) = update.username {
            self.username = username.trim().to_string();
        }
        if let Some(password) = update.password {
            self.password = password;
        }
        if let Some(downloads_dir) = update.downloads_dir {
            self.downloads_dir = downloads_dir.trim().to_string();
        }
        if let Some(client_downloads_dir) = update.client_downloads_dir {
            self.client_downloads_dir = client_downloads_dir.trim().to_string();
        }
        if let Some(category) = update.default_category {
            self.default_category = category.trim().to_string();
        }
        if let Some(tags) = update.default_tags {
            self.default_tags = normalize_tags(tags);
        }

        self.base_url = base_url;
        Ok(())
    }
}

/// Split a comma-separated tag list, trimming and dropping duplicates.
pub fn parse_tags(value: &str) -> Vec<String> {
    normalize_tags([value])
}

/// Normalize tag values, splitting any comma-separated entries.
pub fn normalize_tags<I, S>(tags: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for raw in tags {
        for part in raw.as_ref().split(',') {
            let tag = part.trim();
            if tag.is_empty() {
                continue;
            }
            let tag = tag.to_string();
            if seen.insert(tag.clone()) {
                normalized.push(tag);
            }
        }
    }
    normalized
}

/// Validate and canonicalize the torrent client Web UI URL.
pub fn normalize_base_url(raw: &str) -> std::result::Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Enter the torrent client's Web UI URL.".to_string());
    }

    let url =
        Url::parse(trimmed).map_err(|_| "Enter a valid http:// or https:// URL.".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("The torrent client URL must use http:// or https://.".to_string());
    }
    if url.host_str().is_none() {
        return Err("The torrent client URL needs a host.".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Put credentials in the fields below, not in the URL.".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("The torrent client URL cannot include a query or fragment.".to_string());
    }

    let mut normalized = url.to_string();
    while normalized.ends_with('/') {
        normalized.pop();
    }
    Ok(normalized)
}

/// Read `config.json`, creating it from the environment on first boot.
pub fn load_or_create(path: &Path, env: ConfigEnv) -> Result<(Config, bool)> {
    if path.exists() {
        let raw =
            std::fs::read(path).with_context(|| format!("could not read {}", path.display()))?;
        let mut config: Config = serde_json::from_slice(&raw)
            .with_context(|| format!("could not parse {}", path.display()))?;
        // Tolerate a hand-edited trailing slash even though the API normalizes.
        config.base_url = normalize_base_url(&config.base_url).map_err(anyhow::Error::msg)?;
        config.downloads_dir = config.downloads_dir.trim().to_string();
        config.client_downloads_dir = config.client_downloads_dir.trim().to_string();
        config.default_category = config.default_category.trim().to_string();
        config.default_tags = normalize_tags(std::mem::take(&mut config.default_tags));
        config.validate()?;
        return Ok((config, false));
    }

    let config = Config::from_env(env)?;
    save_sync(path, &config)?;
    Ok((config, true))
}

pub fn save_sync(path: &Path, config: &Config) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("could not create {}", parent.display()))?;
    }

    let bytes = serde_json::to_vec_pretty(config)?;
    let temporary = temporary_path(path);
    std::fs::write(&temporary, bytes)
        .with_context(|| format!("could not write {}", temporary.display()))?;
    restrict_permissions(&temporary)?;
    std::fs::rename(&temporary, path)
        .with_context(|| format!("could not replace {}", path.display()))?;
    Ok(())
}

pub async fn save(path: &Path, config: &Config) -> Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("could not create {}", parent.display()))?;
    }

    let bytes = serde_json::to_vec_pretty(config)?;
    let temporary = temporary_path(path);
    tokio::fs::write(&temporary, bytes)
        .await
        .with_context(|| format!("could not write {}", temporary.display()))?;
    restrict_permissions(&temporary)?;
    tokio::fs::rename(&temporary, path)
        .await
        .with_context(|| format!("could not replace {}", path.display()))?;
    Ok(())
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(".tmp");
    PathBuf::from(temporary)
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .with_context(|| format!("could not restrict permissions on {}", path.display()))
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env() -> ConfigEnv {
        ConfigEnv {
            client_kind: ClientKind::Qbittorrent,
            base_url: "http://gluetun:8080/".to_string(),
            api_key: " qbt_test ".to_string(),
            username: String::new(),
            password: String::new(),
            downloads_dir: " /mnt/downloads ".to_string(),
            client_downloads_dir: " /downloads ".to_string(),
            default_category: " remagnet ".to_string(),
            default_tags: vec![" remagnet ".to_string(), "nas".to_string()],
        }
    }

    #[test]
    fn normalizes_and_rejects_bad_urls() {
        assert_eq!(
            normalize_base_url("https://qbt.example.com/").unwrap(),
            "https://qbt.example.com"
        );
        assert_eq!(
            normalize_base_url("https://qbt.example.com/qbt/").unwrap(),
            "https://qbt.example.com/qbt"
        );
        assert!(normalize_base_url("ftp://qbt.example.com").is_err());
        assert!(normalize_base_url("https://user:pass@qbt.example.com").is_err());
        assert!(normalize_base_url("https://qbt.example.com/?x=1").is_err());
    }

    #[test]
    fn tags_are_split_trimmed_and_deduplicated() {
        assert_eq!(
            parse_tags(" remagnet, nas ,, remagnet,seedbox "),
            vec!["remagnet", "nas", "seedbox"]
        );
        assert!(parse_tags("  ,  ").is_empty());
    }

    #[test]
    fn creates_and_reloads_config() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nested/config.json");

        let (config, created) = load_or_create(&path, env()).unwrap();
        assert!(created);
        assert_eq!(config.client_kind, ClientKind::Qbittorrent);
        assert_eq!(config.base_url, "http://gluetun:8080");
        assert_eq!(config.api_key, "qbt_test");
        assert_eq!(config.downloads_dir, "/mnt/downloads");
        assert_eq!(config.client_downloads_dir, "/downloads");
        assert_eq!(config.default_category, "remagnet");
        assert_eq!(config.default_tags, vec!["remagnet", "nas"]);

        let (reloaded, created) = load_or_create(&path, env()).unwrap();
        assert!(!created);
        assert_eq!(reloaded, config);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn legacy_config_files_get_the_default_magnet_settings() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        std::fs::write(
            &path,
            r#"{"qbitBaseUrl":"http://gluetun:8080","qbitApiKey":"qbt_test"}"#,
        )
        .unwrap();

        let (config, created) = load_or_create(&path, env()).unwrap();
        assert!(!created);
        assert_eq!(config.client_kind, ClientKind::Qbittorrent);
        assert_eq!(config.base_url, "http://gluetun:8080");
        assert_eq!(config.api_key, "qbt_test");
        assert!(config.downloads_dir.is_empty());
        assert_eq!(config.default_category, "remagnet");
        assert_eq!(config.default_tags, vec!["remagnet"]);
    }

    #[test]
    fn neutral_config_names_are_written_and_read_back() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        std::fs::write(
            &path,
            r#"{"clientKind":"transmission","baseUrl":"http://nas:9091","username":"admin","password":"secret","downloadsDir":"/mnt/downloads","clientDownloadsDir":"/downloads"}"#,
        )
        .unwrap();

        let (config, created) = load_or_create(&path, env()).unwrap();
        assert!(!created);
        assert_eq!(config.client_kind, ClientKind::Transmission);
        assert_eq!(config.base_url, "http://nas:9091");
        assert_eq!(config.username, "admin");
        assert_eq!(config.password, "secret");
        assert_eq!(config.downloads_dir, "/mnt/downloads");
        assert_eq!(config.client_downloads_dir, "/downloads");

        save_sync(&path, &config).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"baseUrl\""));
        assert!(raw.contains("\"clientKind\""));
        assert!(!raw.contains("qbitBaseUrl"));
    }

    #[test]
    fn boots_without_client_credentials() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        let env = ConfigEnv {
            api_key: String::new(),
            username: String::new(),
            password: String::new(),
            ..env()
        };

        let (config, created) = load_or_create(&path, env).unwrap();
        assert!(created);
        assert!(!config.has_credentials());
        assert_eq!(config.base_url, DEFAULT_QBIT_BASE_URL);
    }

    #[test]
    fn transmission_is_configured_with_only_a_url() {
        let mut config = Config::from_env(env()).unwrap();
        config.client_kind = ClientKind::Transmission;
        config.api_key.clear();
        config.username.clear();
        config.password.clear();

        assert!(config.has_credentials());

        config.base_url.clear();
        assert!(!config.has_credentials());
    }

    #[test]
    fn default_urls_follow_the_configured_client() {
        assert_eq!(
            resolve_default_base_url(ClientKind::Qbittorrent, None),
            DEFAULT_QBIT_BASE_URL
        );
        assert_eq!(
            resolve_default_base_url(ClientKind::Transmission, None),
            DEFAULT_TRANSMISSION_BASE_URL
        );
        assert_eq!(
            resolve_default_base_url(
                ClientKind::Transmission,
                Some("http://nas:9091".to_string())
            ),
            "http://nas:9091"
        );
    }

    #[test]
    fn update_keeps_omitted_values_and_can_clear_secrets() {
        let mut config = Config::from_env(env()).unwrap();
        config
            .apply_update(ConfigUpdate {
                client_kind: Some(ClientKind::Transmission),
                base_url: "https://qbt.example.com/".to_string(),
                api_key: None,
                username: Some("admin".to_string()),
                password: Some("secret".to_string()),
                downloads_dir: Some(" /srv/downloads ".to_string()),
                client_downloads_dir: Some(" /downloads ".to_string()),
                default_category: Some(" films ".to_string()),
                default_tags: Some(vec![" remagnet, cinema ".to_string()]),
            })
            .unwrap();
        assert_eq!(config.client_kind, ClientKind::Transmission);
        assert_eq!(config.base_url, "https://qbt.example.com");
        assert_eq!(config.api_key, "qbt_test");
        assert_eq!(config.username, "admin");
        assert_eq!(config.password, "secret");
        assert_eq!(config.downloads_dir, "/srv/downloads");
        assert_eq!(config.client_downloads_dir, "/downloads");
        assert_eq!(config.default_category, "films");
        assert_eq!(config.default_tags, vec!["remagnet", "cinema"]);

        config
            .apply_update(ConfigUpdate {
                client_kind: None,
                base_url: "https://qbt.example.com".to_string(),
                api_key: Some(String::new()),
                username: Some(String::new()),
                password: None,
                downloads_dir: None,
                client_downloads_dir: None,
                default_category: Some(String::new()),
                default_tags: Some(Vec::new()),
            })
            .unwrap();
        assert!(config.api_key.is_empty());
        assert!(config.username.is_empty());
        // The update kept Transmission selected, which only needs a URL.
        assert!(config.has_credentials());
        assert!(config.default_category.is_empty());
        assert!(config.default_tags.is_empty());

        config.client_kind = ClientKind::Qbittorrent;
        assert!(!config.has_credentials());
    }
}
