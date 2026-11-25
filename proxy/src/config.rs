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
pub const DEFAULT_DELUGE_BASE_URL: &str = "http://deluge:8112";
pub const DEFAULT_RTORRENT_BASE_URL: &str = "http://rtorrent:8000";

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
/// Field names are client-neutral.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default)]
    pub client_kind: ClientKind,
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
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
            base_url: resolve_default_base_url(client_kind, env_base_url()),
            api_key: env::var("QBIT_API_KEY").unwrap_or_default(),
            username: env_username().unwrap_or_default(),
            password: env_password().unwrap_or_default(),
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

/// The first non-empty base URL supplied by the environment.
fn env_base_url() -> Option<String> {
    env_non_empty("CLIENT_BASE_URL")
}

/// The first non-empty username supplied by the environment.
fn env_username() -> Option<String> {
    env_non_empty("CLIENT_USERNAME")
}

/// The first non-empty password supplied by the environment.
fn env_password() -> Option<String> {
    env_non_empty("CLIENT_PASSWORD").or_else(|| env_non_empty("DELUGE_PASSWORD"))
}

/// Pick the bootstrap URL for the configured client kind.
///
/// Transmission often runs without authentication on a private network, so its
/// default is used whenever no explicit URL was supplied.
fn resolve_default_base_url(client_kind: ClientKind, explicit: Option<String>) -> String {
    explicit.unwrap_or_else(|| match client_kind {
        ClientKind::Qbittorrent => DEFAULT_QBIT_BASE_URL.to_string(),
        ClientKind::Transmission => DEFAULT_TRANSMISSION_BASE_URL.to_string(),
        ClientKind::Deluge => DEFAULT_DELUGE_BASE_URL.to_string(),
        ClientKind::Rtorrent => DEFAULT_RTORRENT_BASE_URL.to_string(),
    })
}

/// Configuration fields supplied by the environment.
///
/// An override wins over `config.json` for the lifetime of the process and is
/// reported to the config page so the UI can mark the field as read-only.
/// Empty values are treated as absent for most variables so a container that
/// declares `QBIT_API_KEY=` but leaves it blank does not lock the saved key.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EnvOverrides {
    pub client_kind: Option<ClientKind>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub downloads_dir: Option<String>,
    pub client_downloads_dir: Option<String>,
    pub default_category: Option<String>,
    pub default_tags: Option<Vec<String>>,
}

impl EnvOverrides {
    pub fn from_env() -> Result<Self> {
        let base_url = env_base_url()
            .map(|raw| normalize_base_url(&raw))
            .transpose()
            .map_err(anyhow::Error::msg)?;

        Ok(Self {
            client_kind: env_non_empty("CLIENT_KIND")
                .and_then(|value| ClientKind::from_str_loose(&value)),
            base_url,
            api_key: env_non_empty("QBIT_API_KEY").map(|value| value.trim().to_string()),
            username: env_username().map(|value| value.trim().to_string()),
            password: env_password(),
            downloads_dir: env_non_empty("DOWNLOADS_DIR").map(|value| value.trim().to_string()),
            client_downloads_dir: env_non_empty("CLIENT_DOWNLOADS_DIR")
                .map(|value| value.trim().to_string()),
            // An explicitly empty category or tag list disables matching, so
            // presence rather than non-emptiness decides whether it locks.
            default_category: env::var("REMAGNET_CATEGORY")
                .ok()
                .map(|value| value.trim().to_string()),
            default_tags: env::var("REMAGNET_TAGS")
                .ok()
                .map(|value| parse_tags(&value)),
        })
    }

    /// camelCase field names overridden by the environment, in the same order
    /// as [`PublicConfig`] and [`ConfigUpdate`].
    pub fn locked_fields(&self) -> Vec<String> {
        let mut fields = Vec::new();
        if self.client_kind.is_some() {
            fields.push("clientKind".to_string());
        }
        if self.base_url.is_some() {
            fields.push("baseUrl".to_string());
        }
        if self.api_key.is_some() {
            fields.push("apiKey".to_string());
        }
        if self.username.is_some() {
            fields.push("username".to_string());
        }
        if self.password.is_some() {
            fields.push("password".to_string());
        }
        if self.downloads_dir.is_some() {
            fields.push("downloadsDir".to_string());
        }
        if self.client_downloads_dir.is_some() {
            fields.push("clientDownloadsDir".to_string());
        }
        if self.default_category.is_some() {
            fields.push("defaultCategory".to_string());
        }
        if self.default_tags.is_some() {
            fields.push("defaultTags".to_string());
        }
        fields
    }

    /// Apply every environment override on top of a saved configuration.
    pub fn apply_to(&self, config: &mut Config) {
        if let Some(kind) = self.client_kind {
            // Switching clients through the environment should also move off
            // any built-in URL, unless a URL was supplied.
            if self.base_url.is_none()
                && matches!(
                    config.base_url.as_str(),
                    DEFAULT_QBIT_BASE_URL
                        | DEFAULT_TRANSMISSION_BASE_URL
                        | DEFAULT_DELUGE_BASE_URL
                        | DEFAULT_RTORRENT_BASE_URL
                )
            {
                config.base_url = resolve_default_base_url(kind, None);
            }
            config.client_kind = kind;
        }
        if let Some(base_url) = &self.base_url {
            config.base_url = base_url.clone();
        }
        if let Some(api_key) = &self.api_key {
            config.api_key = api_key.trim().to_string();
        }
        if let Some(username) = &self.username {
            config.username = username.trim().to_string();
        }
        if let Some(password) = &self.password {
            config.password = password.clone();
        }
        if let Some(downloads_dir) = &self.downloads_dir {
            config.downloads_dir = downloads_dir.trim().to_string();
        }
        if let Some(client_downloads_dir) = &self.client_downloads_dir {
            config.client_downloads_dir = client_downloads_dir.trim().to_string();
        }
        if let Some(category) = &self.default_category {
            config.default_category = category.trim().to_string();
        }
        if let Some(tags) = &self.default_tags {
            config.default_tags = normalize_tags(tags);
        }
    }
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
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
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
    pub username: String,
    pub has_api_key: bool,
    pub has_password: bool,
    pub downloads_dir: String,
    pub client_downloads_dir: String,
    pub default_category: String,
    pub default_tags: Vec<String>,
    /// Whether enough torrent client settings are saved to talk to the client.
    pub configured: bool,
    /// camelCase field names supplied by the environment and read-only in the UI.
    pub env_locked: Vec<String>,
}

impl PublicConfig {
    pub fn from_config(config: &Config, overrides: &EnvOverrides) -> Self {
        Self {
            client_kind: config.client_kind,
            base_url: config.base_url.clone(),
            username: config.username.clone(),
            has_api_key: !config.api_key.is_empty(),
            has_password: !config.password.is_empty(),
            downloads_dir: config.downloads_dir.clone(),
            client_downloads_dir: config.client_downloads_dir.clone(),
            default_category: config.default_category.clone(),
            default_tags: config.default_tags.clone(),
            configured: config.has_credentials(),
            env_locked: overrides.locked_fields(),
        }
    }
}

impl From<&Config> for PublicConfig {
    fn from(config: &Config) -> Self {
        Self::from_config(config, &EnvOverrides::default())
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
    /// only requirement for it. rTorrent can also run without HTTP
    /// authentication, while Deluge Web UI always needs its password.
    pub fn has_credentials(&self) -> bool {
        match self.client_kind {
            ClientKind::Qbittorrent => !self.api_key.is_empty() || !self.username.is_empty(),
            ClientKind::Transmission => !self.base_url.is_empty(),
            ClientKind::Deluge => !self.base_url.is_empty() && !self.password.is_empty(),
            ClientKind::Rtorrent => !self.base_url.is_empty(),
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
        self.apply_update_with_overrides(update, &EnvOverrides::default())
    }

    /// Apply a config-page update without replacing environment overrides.
    ///
    /// The effective configuration already contains the environment values, so
    /// locked fields are left untouched even when the request includes them.
    pub fn apply_update_with_overrides(
        &mut self,
        update: ConfigUpdate,
        overrides: &EnvOverrides,
    ) -> std::result::Result<(), String> {
        let base_url = match (update.base_url, overrides.base_url.is_some()) {
            (_, true) | (None, false) => self.base_url.clone(),
            (Some(raw), false) => normalize_base_url(&raw)?,
        };

        if let Some(kind) = update.client_kind {
            if overrides.client_kind.is_none() {
                self.client_kind = kind;
            }
        }
        if let Some(api_key) = update.api_key {
            if overrides.api_key.is_none() {
                self.api_key = api_key.trim().to_string();
            }
        }
        if let Some(username) = update.username {
            if overrides.username.is_none() {
                self.username = username.trim().to_string();
            }
        }
        if let Some(password) = update.password {
            if overrides.password.is_none() {
                self.password = password;
            }
        }
        if let Some(downloads_dir) = update.downloads_dir {
            if overrides.downloads_dir.is_none() {
                self.downloads_dir = downloads_dir.trim().to_string();
            }
        }
        if let Some(client_downloads_dir) = update.client_downloads_dir {
            if overrides.client_downloads_dir.is_none() {
                self.client_downloads_dir = client_downloads_dir.trim().to_string();
            }
        }
        if let Some(category) = update.default_category {
            if overrides.default_category.is_none() {
                self.default_category = category.trim().to_string();
            }
        }
        if let Some(tags) = update.default_tags {
            if overrides.default_tags.is_none() {
                self.default_tags = normalize_tags(tags);
            }
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
        return Err("Supply credentials separately rather than inside the URL.".to_string());
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
///
/// Returned configuration is the effective one: saved values with every
/// environment override applied. The file itself only changes on first boot,
/// and environment-provided secrets are kept out of it.
pub fn load_or_create(
    path: &Path,
    env: ConfigEnv,
    overrides: &EnvOverrides,
) -> Result<(Config, bool)> {
    if path.exists() {
        let raw =
            std::fs::read(path).with_context(|| format!("could not read {}", path.display()))?;
        let mut file_config: Config = serde_json::from_slice(&raw)
            .with_context(|| format!("could not parse {}", path.display()))?;
        // Tolerate a hand-edited trailing slash even though the API normalizes.
        file_config.base_url =
            normalize_base_url(&file_config.base_url).map_err(anyhow::Error::msg)?;
        file_config.downloads_dir = file_config.downloads_dir.trim().to_string();
        file_config.client_downloads_dir = file_config.client_downloads_dir.trim().to_string();
        file_config.default_category = file_config.default_category.trim().to_string();
        file_config.default_tags = normalize_tags(std::mem::take(&mut file_config.default_tags));

        let mut config = file_config;
        overrides.apply_to(&mut config);
        config.validate()?;
        return Ok((config, false));
    }

    let mut config = Config::from_env(env)?;
    overrides.apply_to(&mut config);
    save_sync(path, &persisted_config(&config, overrides))?;
    Ok((config, true))
}

/// Copy of the effective configuration that is safe to write to disk.
///
/// Values that exist only because of an environment variable stay in memory;
/// in particular, locking an API key or password must never copy it into
/// `config.json`.
pub fn persisted_config(config: &Config, overrides: &EnvOverrides) -> Config {
    let mut persisted = config.clone();
    if overrides.api_key.is_some() {
        persisted.api_key.clear();
    }
    if overrides.password.is_some() {
        persisted.password.clear();
    }
    persisted
}

pub fn save_sync(path: &Path, config: &Config) -> Result<()> {
    write_private_json_sync(path, config)
}

pub async fn save(path: &Path, config: &Config) -> Result<()> {
    write_private_json(path, config).await
}

/// Write JSON to `path` atomically, readable only by the proxy's user.
///
/// The value is written to a sibling temporary file, restricted to `0o600`, and
/// renamed over the destination so a crash never leaves a partial file.
pub fn write_private_json_sync<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("could not create {}", parent.display()))?;
    }

    let bytes = serde_json::to_vec_pretty(value)?;
    let temporary = temporary_path(path);
    std::fs::write(&temporary, bytes)
        .with_context(|| format!("could not write {}", temporary.display()))?;
    restrict_permissions(&temporary)?;
    std::fs::rename(&temporary, path)
        .with_context(|| format!("could not replace {}", path.display()))?;
    Ok(())
}

/// Async variant of [`write_private_json_sync`].
pub async fn write_private_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("could not create {}", parent.display()))?;
    }

    let bytes = serde_json::to_vec_pretty(value)?;
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
    use std::sync::Mutex;

    use super::*;

    const ENV_NAMES: &[&str] = &[
        "CLIENT_KIND",
        "CLIENT_BASE_URL",
        "QBIT_API_KEY",
        "CLIENT_USERNAME",
        "CLIENT_PASSWORD",
        "DELUGE_PASSWORD",
        "DOWNLOADS_DIR",
        "CLIENT_DOWNLOADS_DIR",
        "REMAGNET_CATEGORY",
        "REMAGNET_TAGS",
    ];

    /// Environment variables are process-global, so tests that set them must
    /// not run concurrently with each other.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvGuard {
        names: Vec<&'static str>,
    }

    impl EnvGuard {
        fn new(vars: &[(&'static str, &str)]) -> Self {
            let names = ENV_NAMES.to_vec();
            for name in &names {
                env::remove_var(name);
            }
            for (name, value) in vars {
                env::set_var(name, value);
            }
            Self { names }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for name in &self.names {
                env::remove_var(name);
            }
        }
    }

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

        let (config, created) = load_or_create(&path, env(), &EnvOverrides::default()).unwrap();
        assert!(created);
        assert_eq!(config.client_kind, ClientKind::Qbittorrent);
        assert_eq!(config.base_url, "http://gluetun:8080");
        assert_eq!(config.api_key, "qbt_test");
        assert_eq!(config.downloads_dir, "/mnt/downloads");
        assert_eq!(config.client_downloads_dir, "/downloads");
        assert_eq!(config.default_category, "remagnet");
        assert_eq!(config.default_tags, vec!["remagnet", "nas"]);

        let (reloaded, created) = load_or_create(&path, env(), &EnvOverrides::default()).unwrap();
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
    fn neutral_config_names_are_written_and_read_back() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        std::fs::write(
            &path,
            r#"{"clientKind":"transmission","baseUrl":"http://nas:9091","username":"admin","password":"secret","downloadsDir":"/mnt/downloads","clientDownloadsDir":"/downloads"}"#,
        )
        .unwrap();

        let (config, created) = load_or_create(&path, env(), &EnvOverrides::default()).unwrap();
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

        let (config, created) = load_or_create(&path, env, &EnvOverrides::default()).unwrap();
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
            resolve_default_base_url(ClientKind::Deluge, None),
            DEFAULT_DELUGE_BASE_URL
        );
        assert_eq!(
            resolve_default_base_url(ClientKind::Rtorrent, None),
            DEFAULT_RTORRENT_BASE_URL
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
    fn deluge_and_rtorrent_have_their_own_credential_rules() {
        let mut deluge = Config::from_env(env()).unwrap();
        deluge.client_kind = ClientKind::Deluge;
        assert!(!deluge.has_credentials());
        deluge.password = "secret".to_string();
        assert!(deluge.has_credentials());
        deluge.base_url.clear();
        assert!(!deluge.has_credentials());

        let mut rtorrent = Config::from_env(env()).unwrap();
        rtorrent.client_kind = ClientKind::Rtorrent;
        rtorrent.password.clear();
        assert!(rtorrent.has_credentials());
        rtorrent.base_url.clear();
        assert!(!rtorrent.has_credentials());
    }

    #[test]
    fn environment_selects_deluge_and_rtorrent_with_their_defaults() {
        let _lock = ENV_LOCK.lock().unwrap();

        {
            let _guard = EnvGuard::new(&[
                ("CLIENT_KIND", "deluge"),
                ("CLIENT_BASE_URL", " http://deluge.local:8112/ "),
                ("DELUGE_PASSWORD", "secret"),
            ]);
            let overrides = EnvOverrides::from_env().unwrap();
            let mut config = Config::from_env(env()).unwrap();
            overrides.apply_to(&mut config);
            assert_eq!(config.client_kind, ClientKind::Deluge);
            assert_eq!(config.base_url, "http://deluge.local:8112");
            assert_eq!(config.password, "secret");
            assert!(config.has_credentials());
        }

        {
            let _guard = EnvGuard::new(&[
                ("CLIENT_KIND", "rutorrent"),
                ("CLIENT_BASE_URL", "http://rtorrent.local:8000"),
            ]);
            let overrides = EnvOverrides::from_env().unwrap();
            let mut config = Config::from_env(env()).unwrap();
            overrides.apply_to(&mut config);
            assert_eq!(config.client_kind, ClientKind::Rtorrent);
            assert_eq!(config.base_url, "http://rtorrent.local:8000");
            assert!(config.has_credentials());
        }
    }

    #[test]
    fn update_keeps_omitted_values_and_can_clear_secrets() {
        let mut config = Config::from_env(env()).unwrap();
        config
            .apply_update(ConfigUpdate {
                client_kind: Some(ClientKind::Transmission),
                base_url: Some("https://qbt.example.com/".to_string()),
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
                base_url: Some("https://qbt.example.com".to_string()),
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

    #[test]
    fn environment_overrides_saved_config_without_rewriting_it() {
        let _lock = ENV_LOCK.lock().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        let mut saved = Config::from_env(env()).unwrap();
        saved.api_key = "saved_key".to_string();
        saved.downloads_dir = "/saved/downloads".to_string();
        save_sync(&path, &saved).unwrap();
        let original = std::fs::read_to_string(&path).unwrap();

        {
            let _guard = EnvGuard::new(&[
                ("CLIENT_KIND", "transmission"),
                ("CLIENT_BASE_URL", " http://nas:9091/ "),
                ("QBIT_API_KEY", " env_key "),
                ("DOWNLOADS_DIR", " /env/downloads "),
                ("REMAGNET_TAGS", " env, tags "),
            ]);
            let overrides = EnvOverrides::from_env().unwrap();
            assert_eq!(
                overrides.locked_fields(),
                vec![
                    "clientKind",
                    "baseUrl",
                    "apiKey",
                    "downloadsDir",
                    "defaultTags"
                ]
            );

            let (config, created) = load_or_create(&path, env(), &overrides).unwrap();
            assert!(!created);
            assert_eq!(config.client_kind, ClientKind::Transmission);
            assert_eq!(config.base_url, "http://nas:9091");
            assert_eq!(config.api_key, "env_key");
            assert_eq!(config.downloads_dir, "/env/downloads");
            assert_eq!(config.default_tags, vec!["env", "tags"]);
            // The saved file keeps the UI-managed values, not env secrets.
            assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        }
    }

    #[test]
    fn empty_environment_values_do_not_lock_except_magnet_filters() {
        let _lock = ENV_LOCK.lock().unwrap();
        let _guard = EnvGuard::new(&[
            ("QBIT_API_KEY", ""),
            ("DOWNLOADS_DIR", "   "),
            ("REMAGNET_CATEGORY", "   "),
            ("REMAGNET_TAGS", ""),
        ]);

        let overrides = EnvOverrides::from_env().unwrap();
        assert!(overrides.api_key.is_none());
        assert!(overrides.downloads_dir.is_none());
        // Presence, not content, controls the magnet filters.
        assert_eq!(overrides.default_category, Some(String::new()));
        assert_eq!(overrides.default_tags, Some(Vec::new()));
        assert_eq!(
            overrides.locked_fields(),
            vec!["defaultCategory", "defaultTags"]
        );

        let mut config = Config::from_env(env()).unwrap();
        overrides.apply_to(&mut config);
        assert_eq!(config.api_key, "qbt_test");
        assert_eq!(config.downloads_dir, "/mnt/downloads");
        assert!(config.default_category.is_empty());
        assert!(config.default_tags.is_empty());
    }

    #[test]
    fn removing_environment_variables_restores_the_saved_config() {
        let _lock = ENV_LOCK.lock().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        let mut saved = Config::from_env(env()).unwrap();
        saved.api_key = "saved_key".to_string();
        saved.downloads_dir = "/saved/downloads".to_string();
        save_sync(&path, &saved).unwrap();

        {
            let _guard = EnvGuard::new(&[
                ("QBIT_API_KEY", "env_key"),
                ("DOWNLOADS_DIR", "/env/downloads"),
            ]);
            let overrides = EnvOverrides::from_env().unwrap();
            let (config, _) = load_or_create(&path, env(), &overrides).unwrap();
            assert_eq!(config.api_key, "env_key");
            assert_eq!(config.downloads_dir, "/env/downloads");
        }

        let overrides = EnvOverrides::from_env().unwrap();
        assert!(overrides.locked_fields().is_empty());
        let (config, created) = load_or_create(&path, env(), &overrides).unwrap();
        assert!(!created);
        assert_eq!(config.api_key, "saved_key");
        assert_eq!(config.downloads_dir, "/saved/downloads");
    }

    #[test]
    fn environment_overrides_move_off_the_previous_clients_default_url() {
        let mut config = Config::from_env(env()).unwrap();
        config.base_url = DEFAULT_QBIT_BASE_URL.to_string();
        let overrides = EnvOverrides {
            client_kind: Some(ClientKind::Transmission),
            ..EnvOverrides::default()
        };

        overrides.apply_to(&mut config);
        assert_eq!(config.client_kind, ClientKind::Transmission);
        assert_eq!(config.base_url, DEFAULT_TRANSMISSION_BASE_URL);

        // Any built-in default moves to the newly selected client's default.
        config.base_url = DEFAULT_DELUGE_BASE_URL.to_string();
        let overrides = EnvOverrides {
            client_kind: Some(ClientKind::Rtorrent),
            ..EnvOverrides::default()
        };
        overrides.apply_to(&mut config);
        assert_eq!(config.client_kind, ClientKind::Rtorrent);
        assert_eq!(config.base_url, DEFAULT_RTORRENT_BASE_URL);

        // An explicit URL always wins over the default.
        let overrides = EnvOverrides {
            client_kind: Some(ClientKind::Qbittorrent),
            base_url: Some("http://qbt.example.com".to_string()),
            ..EnvOverrides::default()
        };
        overrides.apply_to(&mut config);
        assert_eq!(config.client_kind, ClientKind::Qbittorrent);
        assert_eq!(config.base_url, "http://qbt.example.com");
    }

    #[test]
    fn updates_preserve_environment_locked_fields() {
        let mut config = Config::from_env(env()).unwrap();
        let overrides = EnvOverrides {
            client_kind: Some(ClientKind::Transmission),
            base_url: Some("http://env:9091".to_string()),
            api_key: Some("env_key".to_string()),
            username: Some("env_user".to_string()),
            password: Some("env_pass".to_string()),
            downloads_dir: Some("/env/downloads".to_string()),
            client_downloads_dir: Some("/env/client".to_string()),
            default_category: Some("env_cat".to_string()),
            default_tags: Some(vec!["env_tag".to_string()]),
        };
        overrides.apply_to(&mut config);

        config
            .apply_update_with_overrides(
                ConfigUpdate {
                    client_kind: Some(ClientKind::Qbittorrent),
                    base_url: Some("http://ui:8080".to_string()),
                    api_key: Some("ui_key".to_string()),
                    username: Some("ui_user".to_string()),
                    password: Some("ui_pass".to_string()),
                    downloads_dir: Some("/ui/downloads".to_string()),
                    client_downloads_dir: Some("/ui/client".to_string()),
                    default_category: Some("ui_cat".to_string()),
                    default_tags: Some(vec!["ui_tag".to_string()]),
                },
                &overrides,
            )
            .unwrap();

        assert_eq!(config.client_kind, ClientKind::Transmission);
        assert_eq!(config.base_url, "http://env:9091");
        assert_eq!(config.api_key, "env_key");
        assert_eq!(config.username, "env_user");
        assert_eq!(config.password, "env_pass");
        assert_eq!(config.downloads_dir, "/env/downloads");
        assert_eq!(config.client_downloads_dir, "/env/client");
        assert_eq!(config.default_category, "env_cat");
        assert_eq!(config.default_tags, vec!["env_tag"]);
    }

    #[test]
    fn updates_apply_to_unlocked_fields_only() {
        let mut config = Config::from_env(env()).unwrap();
        let overrides = EnvOverrides {
            api_key: Some("env_key".to_string()),
            ..EnvOverrides::default()
        };
        overrides.apply_to(&mut config);

        config
            .apply_update_with_overrides(
                ConfigUpdate {
                    client_kind: None,
                    // Omitting baseUrl keeps the current one.
                    base_url: None,
                    api_key: Some("ui_key".to_string()),
                    username: Some("ui_user".to_string()),
                    password: None,
                    downloads_dir: Some(" /ui/downloads ".to_string()),
                    client_downloads_dir: None,
                    default_category: Some(" ui_cat ".to_string()),
                    default_tags: Some(vec![" ui_tag ".to_string()]),
                },
                &overrides,
            )
            .unwrap();

        assert_eq!(config.api_key, "env_key");
        assert_eq!(config.base_url, "http://gluetun:8080");
        assert_eq!(config.username, "ui_user");
        assert_eq!(config.downloads_dir, "/ui/downloads");
        assert_eq!(config.default_category, "ui_cat");
        assert_eq!(config.default_tags, vec!["ui_tag"]);
    }

    #[test]
    fn public_config_reports_configured_and_locked_fields() {
        let config = Config::from_env(env()).unwrap();
        let public = PublicConfig::from(&config);
        assert!(public.configured);
        assert!(public.env_locked.is_empty());

        let overrides = EnvOverrides {
            api_key: Some("env_key".to_string()),
            default_tags: Some(Vec::new()),
            ..EnvOverrides::default()
        };
        let public = PublicConfig::from_config(&config, &overrides);
        assert_eq!(public.env_locked, vec!["apiKey", "defaultTags"]);
    }
}
