mod auth;
mod config;
mod error;
mod pairing;
mod qbit;
mod routes;
mod zipstream;

use std::{
    env,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use anyhow::{bail, Context, Result};
use tokio::sync::RwLock;
use tracing_subscriber::EnvFilter;

use crate::{config::Config, qbit::QbitClient};

/// Shared state for every request.
///
/// The qBittorrent client is swapped atomically when the config page saves new
/// settings; requests clone the current client out of the read lock and keep
/// using it even if a save happens mid-download.
pub struct AppState {
    pub config_path: PathBuf,
    pub config: RwLock<Config>,
    pub qbit: RwLock<QbitClient>,
    pub token: String,
    pub pairings: Mutex<pairing::PairingStore>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let token = env::var("BRIDGE_TOKEN")
        .unwrap_or_default()
        .trim()
        .to_string();
    if token.len() < 16 {
        bail!("BRIDGE_TOKEN must be set to at least 16 characters.");
    }

    let data_dir = env::var("DATA_DIR").unwrap_or_else(|_| "/data".to_string());
    let config_path = Path::new(&data_dir).join("config.json");
    let (config, created) = config::load_or_create(&config_path, config::ConfigEnv::from_env())
        .context("could not load the bridge configuration")?;
    let qbit = QbitClient::new(&config).context("could not initialize qBittorrent")?;

    if created {
        tracing::info!(
            path = %config_path.display(),
            qbit = %config.qbit_base_url,
            "created a bridge configuration from environment variables"
        );
    }

    let state = Arc::new(AppState {
        config_path,
        config: RwLock::new(config),
        qbit: RwLock::new(qbit),
        token,
        pairings: Mutex::new(pairing::PairingStore::default()),
    });

    let bind = env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".to_string());
    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .with_context(|| format!("could not bind {bind}"))?;
    tracing::info!(
        addr = %bind,
        config = %state.config_path.display(),
        "remagnet-bridge listening"
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
