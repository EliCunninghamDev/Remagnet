use std::{
    env,
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use url::Url;

pub const DEFAULT_QBIT_BASE_URL: &str = "http://gluetun:8080";

/// Settings persisted in `DATA_DIR/config.json`.
///
/// The bridge token is intentionally not stored here: it comes from the
/// `BRIDGE_TOKEN` environment variable so it can live in a server-only `.env`
/// and never be returned by the config API.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub qbit_base_url: String,
    #[serde(default)]
    pub qbit_api_key: String,
    #[serde(default)]
    pub qbit_username: String,
    #[serde(default)]
    pub qbit_password: String,
}

/// Bootstrap values read from the environment when no config file exists yet.
pub struct ConfigEnv {
    pub qbit_base_url: String,
    pub qbit_api_key: String,
    pub qbit_username: String,
    pub qbit_password: String,
}

impl ConfigEnv {
    pub fn from_env() -> Self {
        Self {
            qbit_base_url: env::var("QBIT_BASE_URL")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_QBIT_BASE_URL.to_string()),
            qbit_api_key: env::var("QBIT_API_KEY").unwrap_or_default(),
            qbit_username: env::var("QBIT_USERNAME").unwrap_or_default(),
            qbit_password: env::var("QBIT_PASSWORD").unwrap_or_default(),
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
    pub qbit_base_url: String,
    #[serde(default)]
    pub qbit_api_key: Option<String>,
    #[serde(default)]
    pub qbit_username: Option<String>,
    #[serde(default)]
    pub qbit_password: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicConfig {
    pub qbit_base_url: String,
    pub qbit_username: String,
    pub has_api_key: bool,
    pub has_password: bool,
}

impl From<&Config> for PublicConfig {
    fn from(config: &Config) -> Self {
        Self {
            qbit_base_url: config.qbit_base_url.clone(),
            qbit_username: config.qbit_username.clone(),
            has_api_key: !config.qbit_api_key.is_empty(),
            has_password: !config.qbit_password.is_empty(),
        }
    }
}

impl Config {
    pub fn from_env(env: ConfigEnv) -> Result<Self> {
        let config = Self {
            qbit_base_url: normalize_base_url(&env.qbit_base_url).map_err(anyhow::Error::msg)?,
            qbit_api_key: env.qbit_api_key.trim().to_string(),
            qbit_username: env.qbit_username.trim().to_string(),
            qbit_password: env.qbit_password,
        };
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<()> {
        let normalized = normalize_base_url(&self.qbit_base_url).map_err(anyhow::Error::msg)?;
        if normalized != self.qbit_base_url {
            bail!("qBittorrent base URL is not normalized: {normalized}");
        }
        if self.qbit_api_key.is_empty() && self.qbit_username.is_empty() {
            bail!("Set QBIT_API_KEY or QBIT_USERNAME for qBittorrent.");
        }
        Ok(())
    }

    pub fn apply_update(&mut self, update: ConfigUpdate) -> std::result::Result<(), String> {
        let base_url = normalize_base_url(&update.qbit_base_url)?;

        if let Some(api_key) = update.qbit_api_key {
            self.qbit_api_key = api_key.trim().to_string();
        }
        if let Some(username) = update.qbit_username {
            self.qbit_username = username.trim().to_string();
        }
        if let Some(password) = update.qbit_password {
            self.qbit_password = password;
        }

        if self.qbit_api_key.is_empty() && self.qbit_username.is_empty() {
            return Err("Provide an API key or a qBittorrent username/password.".to_string());
        }

        self.qbit_base_url = base_url;
        Ok(())
    }
}

/// Validate and canonicalize the qBittorrent Web UI URL.
pub fn normalize_base_url(raw: &str) -> std::result::Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Enter the qBittorrent Web UI URL.".to_string());
    }

    let url =
        Url::parse(trimmed).map_err(|_| "Enter a valid http:// or https:// URL.".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("The qBittorrent URL must use http:// or https://.".to_string());
    }
    if url.host_str().is_none() {
        return Err("The qBittorrent URL needs a host.".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Put credentials in the fields below, not in the URL.".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("The qBittorrent URL cannot include a query or fragment.".to_string());
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
        config.qbit_base_url =
            normalize_base_url(&config.qbit_base_url).map_err(anyhow::Error::msg)?;
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
            qbit_base_url: "http://gluetun:8080/".to_string(),
            qbit_api_key: " qbt_test ".to_string(),
            qbit_username: String::new(),
            qbit_password: String::new(),
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
    fn creates_and_reloads_config() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nested/config.json");

        let (config, created) = load_or_create(&path, env()).unwrap();
        assert!(created);
        assert_eq!(config.qbit_base_url, "http://gluetun:8080");
        assert_eq!(config.qbit_api_key, "qbt_test");

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
    fn update_keeps_omitted_secrets_and_can_clear_them() {
        let mut config = Config::from_env(env()).unwrap();
        config
            .apply_update(ConfigUpdate {
                qbit_base_url: "https://qbt.example.com/".to_string(),
                qbit_api_key: None,
                qbit_username: Some("admin".to_string()),
                qbit_password: Some("secret".to_string()),
            })
            .unwrap();
        assert_eq!(config.qbit_base_url, "https://qbt.example.com");
        assert_eq!(config.qbit_api_key, "qbt_test");
        assert_eq!(config.qbit_username, "admin");
        assert_eq!(config.qbit_password, "secret");

        config
            .apply_update(ConfigUpdate {
                qbit_base_url: "https://qbt.example.com".to_string(),
                qbit_api_key: Some(String::new()),
                qbit_username: None,
                qbit_password: None,
            })
            .unwrap();
        assert!(config.qbit_api_key.is_empty());
        assert_eq!(config.qbit_username, "admin");

        let error = config
            .apply_update(ConfigUpdate {
                qbit_base_url: "https://qbt.example.com".to_string(),
                qbit_api_key: None,
                qbit_username: Some(String::new()),
                qbit_password: None,
            })
            .unwrap_err();
        assert!(error.contains("API key"));
    }
}
