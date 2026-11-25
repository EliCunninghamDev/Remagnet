mod auth;
mod auth_routes;
mod backend;
mod bencode;
mod config;
mod deluge;
mod error;
mod pairing;
mod qbit;
mod routes;
mod rtorrent;
mod totp;
mod transmission;
mod xmlrpc;
mod zipstream;

use std::{
    env,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use anyhow::{Context, Result};
use tokio::sync::RwLock;
use tracing_subscriber::EnvFilter;

use crate::{backend::TorrentBackend, config::Config};

/// Shared state for every request.
///
/// The torrent client is swapped atomically when the config page saves new
/// settings; requests clone the current backend out of the read lock and keep
/// using it even if a save happens mid-download. It stays `None` until enough
/// credentials exist, so a fresh proxy can boot and serve its setup page.
pub struct AppState {
    pub config_path: PathBuf,
    /// Effective configuration: `config.json` with environment overrides applied.
    pub config: RwLock<Config>,
    pub env_overrides: config::EnvOverrides,
    pub backend: RwLock<Option<TorrentBackend>>,
    pub auth_path: PathBuf,
    pub auth: RwLock<auth::AuthData>,
    pub setup_code: Option<String>,
    pub sessions: Mutex<auth::SessionStore>,
    pub pending_totp: Mutex<auth::PendingTotpStore>,
    pub archive_tickets: Mutex<auth::ArchiveTicketStore>,
    pub rate_limiter: Mutex<auth::LoginRateLimiter>,
    pub pairings: Mutex<pairing::PairingStore>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let setup_code = env::var("SETUP_CODE")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let data_dir = env::var("DATA_DIR").unwrap_or_else(|_| "/data".to_string());
    let config_path = Path::new(&data_dir).join("config.json");
    let env_overrides = config::EnvOverrides::from_env()
        .context("could not read the configuration overrides from the environment")?;
    let (config, created) =
        config::load_or_create(&config_path, config::ConfigEnv::from_env(), &env_overrides)
            .context("could not load the proxy configuration")?;
    let backend =
        TorrentBackend::from_config(&config).context("could not initialize the torrent client")?;

    let auth_path = Path::new(&data_dir).join("auth.json");
    let auth = auth::load(&auth_path).context("could not load the proxy authentication")?;

    if created {
        tracing::info!(
            path = %config_path.display(),
            client = %config.base_url,
            client_kind = config.client_kind.label(),
            "created a proxy configuration from environment variables"
        );
    }
    if backend.is_none() {
        tracing::warn!(
            "The torrent client is not configured yet; open the Remagnet Proxy page to set it up"
        );
    }

    let state = Arc::new(AppState {
        config_path,
        config: RwLock::new(config),
        env_overrides,
        backend: RwLock::new(backend),
        auth_path,
        auth: RwLock::new(auth),
        setup_code,
        sessions: Mutex::new(auth::SessionStore::default()),
        pending_totp: Mutex::new(auth::PendingTotpStore::default()),
        archive_tickets: Mutex::new(auth::ArchiveTicketStore::default()),
        rate_limiter: Mutex::new(auth::LoginRateLimiter::default()),
        pairings: Mutex::new(pairing::PairingStore::default()),
    });

    let bind = env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".to_string());
    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .with_context(|| format!("could not bind {bind}"))?;
    tracing::info!(
        addr = %bind,
        config = %state.config_path.display(),
        auth = %state.auth_path.display(),
        "remagnet-proxy listening"
    );

    axum::serve(listener, routes::router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("the HTTP server stopped unexpectedly")?;

    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            tracing::error!(%error, "could not listen for Ctrl+C");
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => tracing::error!(%error, "could not listen for SIGTERM"),
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }

    tracing::info!("shutting down");
}
