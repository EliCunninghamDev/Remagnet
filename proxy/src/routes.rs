use std::{
    collections::HashMap,
    sync::{atomic::AtomicBool, Arc, Mutex},
};

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio_util::io::ReaderStream;
use tower_http::trace::TraceLayer;

use crate::{
    auth::is_authorized,
    config::{save, ConfigUpdate, PublicConfig},
    error::AppError,
    qbit::{
        matches_torrent_filter, AddTorrentRequest, AddTorrentResult, QbitClient,
        TorrentCapabilities, TorrentList, TorrentSummary,
    },
    zipstream::{
        content_disposition, torrent_completed, validate_hash, write_zip, zip_filename, ZipStream,
    },
    AppState,
};

type QueryMap = HashMap<String, String>;

const NOT_CONFIGURED: &str =
    "qBittorrent is not configured yet. Open the Remagnet Proxy page to set it up.";

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(ui))
        .route("/icon.svg", get(icon))
        .route("/assets/departure-mono.woff2", get(wordmark_font))
        .route("/healthz", get(healthz))
        .route("/api/health", get(api_health))
        .route("/api/config", get(get_config).put(put_config))
        .route("/api/pair", post(create_pairing))
        .route("/api/pair/claim", post(claim_pairing))
        .route("/api/pair/{id}", delete(revoke_pairing))
        .route("/api/torrents", get(list_torrents).post(add_torrent))
        .route(
            "/api/torrents/{hash}",
            get(get_torrent).delete(delete_torrent),
        )
        .route("/archive/{hash}", get(archive))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn ui() -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
            (
                header::HeaderName::from_static("x-content-type-options"),
                "nosniff",
            ),
        ],
        include_str!("ui.html"),
    )
}

/// Departure Mono for the Remagnet wordmark. The extension ships the same
/// file; keep the copy in sync when the font is updated.
async fn wordmark_font() -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "font/woff2"),
            (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
        ],
        include_bytes!("departure-mono.woff2").as_slice(),
    )
}

/// The application mark, served for the bridge page's favicon.
async fn icon() -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "image/svg+xml"),
            (header::CACHE_CONTROL, "public, max-age=86400"),
        ],
        include_bytes!("icon.svg").as_slice(),
    )
}

async fn healthz() -> Json<serde_json::Value> {
    Json(json!({
        "ok": true,
        "service": "remagnet-bridge",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

async fn api_health(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<QueryMap>,
) -> Result<Json<serde_json::Value>, AppError> {
    require_auth(&state, &headers, &query)?;
    let qbit = require_qbit(&state).await?;
    let (default_category, default_tags) = magnet_defaults(&state).await;
    let (app_version, web_api_version) = qbit.test_connection().await?;

    Ok(Json(json!({
        "ok": true,
        "clientLabel": "qBittorrent",
        "appVersion": app_version,
        "webApiVersion": web_api_version,
        "capabilities": TorrentCapabilities { pause_on_add: true },
        "defaultCategory": default_category,
        "defaultTags": default_tags,
    })))
}

async fn get_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<QueryMap>,
) -> Result<Json<PublicConfig>, AppError> {
    require_auth(&state, &headers, &query)?;
    let config = state.config.read().await;
    Ok(Json(PublicConfig::from(&*config)))
}

async fn put_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<QueryMap>,
    Json(update): Json<ConfigUpdate>,
) -> Result<Json<PublicConfig>, AppError> {
    require_auth(&state, &headers, &query)?;

    let mut candidate = state.config.read().await.clone();
    candidate
        .apply_update(update)
        .map_err(AppError::BadRequest)?;

    // Build the client before touching the file so an invalid URL or HTTP
    // client setup never replaces a working configuration. A proxy without
    // credentials stays bootable with no client until setup is completed.
    let qbit = if candidate.has_credentials() {
        Some(QbitClient::new(&candidate).map_err(AppError::internal)?)
    } else {
        None
    };
    save(&state.config_path, &candidate)
        .await
        .map_err(AppError::internal)?;

    {
        let mut config = state.config.write().await;
        let mut client = state.qbit.write().await;
        *config = candidate.clone();
        *client = qbit;
    }

    Ok(Json(PublicConfig::from(&candidate)))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreatedPairing {
    id: String,
    code: String,
    expires_in: u64,
    url: String,
    uri: String,
    svg: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreatePairingRequest {
    url: Option<String>,
}

/// Mint a short-lived pairing code. The proxy renders the QR image too, so the
/// bridge page does not need a JavaScript QR library and the code stays out of
/// the extension's hands.
async fn create_pairing(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<QueryMap>,
    body: Option<Json<CreatePairingRequest>>,
) -> Result<impl IntoResponse, AppError> {
    require_auth(&state, &headers, &query)?;

    let origin = body
        .and_then(|Json(request)| request.url)
        .or_else(|| origin_from_headers(&headers))
        .ok_or_else(|| {
            AppError::BadRequest("Send the proxy origin as { \"url\": \"https://…\" }.".to_string())
        })?;
    let origin = crate::pairing::normalize_origin(&origin)
        .map_err(|error| AppError::BadRequest(error.to_string()))?;

    let created = {
        let mut store = state
            .pairings
            .lock()
            .map_err(|_| AppError::internal("pairing state is unavailable"))?;
        store.create().map_err(AppError::internal)?
    };

    let uri = crate::pairing::pairing_uri(&origin, &created.id, &created.code);
    let svg = crate::pairing::qr_svg(&uri).map_err(AppError::internal)?;

    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(CreatedPairing {
            id: created.id,
            code: created.code,
            expires_in: created.expires_in,
            url: origin,
            uri,
            svg,
        }),
    ))
}

/// The origin the browser used when it did not send one explicitly.
///
/// Only a fallback for API clients: the bridge page sends `location.origin`,
/// which is what the phone must be able to reach.
fn origin_from_headers(headers: &HeaderMap) -> Option<String> {
    let host = headers.get(header::HOST)?.to_str().ok()?.trim();
    if host.is_empty() {
        return None;
    }

    let forwarded = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|scheme| matches!(*scheme, "http" | "https"))
        .unwrap_or("http");

    Some(format!("{forwarded}://{host}"))
}

#[derive(Debug, Deserialize)]
struct ClaimPairing {
    id: String,
    proof: String,
}

/// The decrypted payload sent to a device that scanned a valid code.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingPayload<'a> {
    version: u8,
    proxy_token: &'a str,
}

/// Claim a pairing code and return the proxy token encrypted with a key
/// derived from the code itself.
async fn claim_pairing(
    State(state): State<Arc<AppState>>,
    Json(claim): Json<ClaimPairing>,
) -> Result<impl IntoResponse, AppError> {
    if claim.id.len() > 64 || claim.proof.len() > 64 {
        return Err(AppError::BadRequest(
            "The pairing code is invalid or expired.".to_string(),
        ));
    }

    let secret = {
        let mut store = state
            .pairings
            .lock()
            .map_err(|_| AppError::internal("pairing state is unavailable"))?;
        store.claim(&claim.id, &claim.proof).ok_or_else(|| {
            AppError::BadRequest("The pairing code is invalid or expired.".to_string())
        })?
    };

    let payload = PairingPayload {
        version: 2,
        proxy_token: &state.token,
    };

    let plaintext = serde_json::to_vec(&payload).map_err(AppError::internal)?;
    let encrypted =
        crate::pairing::encrypt(&secret, &claim.id, &plaintext).map_err(AppError::internal)?;

    Ok(([(header::CACHE_CONTROL, "no-store")], Json(encrypted)))
}

async fn revoke_pairing(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<QueryMap>,
) -> Result<StatusCode, AppError> {
    require_auth(&state, &headers, &query)?;

    let mut store = state
        .pairings
        .lock()
        .map_err(|_| AppError::internal("pairing state is unavailable"))?;
    store.revoke(&id);

    Ok(StatusCode::NO_CONTENT)
}

async fn list_torrents(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<QueryMap>,
) -> Result<Json<TorrentList>, AppError> {
    require_auth(&state, &headers, &query)?;
    let (default_category, default_tags) = magnet_defaults(&state).await;
    let qbit = require_qbit(&state).await?;

    let torrents = qbit
        .list_torrents()
        .await?
        .into_iter()
        .filter(|torrent| {
            matches_torrent_filter(torrent, &default_category, &default_tags)
        })
        .collect();

    Ok(Json(TorrentList { torrents }))
}

async fn get_torrent(
    State(state): State<Arc<AppState>>,
    Path(hash): Path<String>,
    headers: HeaderMap,
    Query(query): Query<QueryMap>,
) -> Result<Json<TorrentSummary>, AppError> {
    require_auth(&state, &headers, &query)?;
    validate_hash(&hash)?;
    let qbit = require_qbit(&state).await?;

    match qbit.get_torrent(&hash).await? {
        Some(torrent) => Ok(Json(torrent)),
        None => Err(AppError::NotFound(
            "Torrent not found in qBittorrent.".to_string(),
        )),
    }
}

async fn add_torrent(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<QueryMap>,
    Json(request): Json<AddTorrentRequest>,
) -> Result<Json<AddTorrentResult>, AppError> {
    require_auth(&state, &headers, &query)?;
    let (default_category, default_tags) = magnet_defaults(&state).await;
    let qbit = require_qbit(&state).await?;

    // Clients cannot choose a category or tag: the proxy always applies its
    // configured defaults so every client agrees on what Remagnet owns.
    let result = qbit
        .add_torrent(
            &request.urls,
            &default_category,
            &default_tags,
            request.paused,
        )
        .await?;

    Ok(Json(result))
}

async fn delete_torrent(
    State(state): State<Arc<AppState>>,
    Path(hash): Path<String>,
    headers: HeaderMap,
    Query(query): Query<QueryMap>,
) -> Result<StatusCode, AppError> {
    require_auth(&state, &headers, &query)?;
    validate_hash(&hash)?;
    let delete_files = parse_delete_files(&query)?;
    let (default_category, default_tags) = magnet_defaults(&state).await;
    let qbit = require_qbit(&state).await?;

    // Only torrents matching the proxy's filter are deletable, so a client
    // cannot remove an unrelated torrent from a shared qBittorrent instance.
    let allowed = qbit
        .get_torrent(&hash)
        .await?
        .is_some_and(|torrent| {
            matches_torrent_filter(&torrent, &default_category, &default_tags)
        });
    if !allowed {
        return Err(AppError::NotFound("Torrent not found.".to_string()));
    }

    qbit.remove_torrent(&hash, delete_files).await?;
    Ok(StatusCode::NO_CONTENT)
}

fn parse_delete_files(query: &QueryMap) -> Result<bool, AppError> {
    match query
        .get("deleteFiles")
        .map(|value| value.trim().to_ascii_lowercase())
        .as_deref()
    {
        None | Some("") | Some("false") => Ok(false),
        Some("true") => Ok(true),
        Some(_) => Err(AppError::BadRequest(
            "deleteFiles must be true or false.".to_string(),
        )),
    }
}

async fn archive(
    State(state): State<Arc<AppState>>,
    Path(hash): Path<String>,
    headers: HeaderMap,
    Query(query): Query<QueryMap>,
) -> Result<Response, AppError> {
    require_auth(&state, &headers, &query)?;
    validate_hash(&hash)?;

    let qbit = require_qbit(&state).await?;
    let torrent = qbit.torrent(&hash).await?;
    if !torrent_completed(&torrent) {
        return Err(AppError::Conflict(format!(
            "{} is not complete yet ({}%).",
            torrent.name,
            (torrent.progress.clamp(0.0, 1.0) * 100.0).round() as u32
        )));
    }

    let mut files = qbit.files(&hash).await?;
    files.sort_by_key(|file| file.index);

    if let Some(incomplete) = files.iter().find(|file| file.progress < 0.999_999) {
        return Err(AppError::Conflict(format!(
            "{} is not fully downloaded yet.",
            incomplete.name
        )));
    }

    files.retain(|file| !file.name.ends_with('/'));
    if files.is_empty() {
        return Err(AppError::Conflict(
            "The torrent has no files to archive.".to_string(),
        ));
    }

    let filename = zip_filename(&torrent.name);
    let (writer, reader) = tokio::io::duplex(1024 * 1024);
    let success = Arc::new(AtomicBool::new(false));
    let failure: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let task_success = Arc::clone(&success);
    let task_failure = Arc::clone(&failure);

    tokio::spawn(async move {
        if let Err(error) = write_zip(writer, qbit, hash.clone(), files, task_success).await {
            // `{error:#}` keeps the whole anyhow chain: the top-level context
            // alone ("could not read …") hides the actual reqwest failure.
            let detail = format!("{error:#}");
            tracing::warn!(hash, error = %detail, "archive stream ended early");
            if let Ok(mut slot) = task_failure.lock() {
                *slot = Some(detail);
            }
        }
    });

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/zip")
        .header(header::CONTENT_DISPOSITION, content_disposition(&filename))
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff")
        .body(Body::from_stream(ZipStream::new(
            ReaderStream::new(reader),
            success,
            failure,
        )))
        .map_err(AppError::internal)
}

fn require_auth(state: &AppState, headers: &HeaderMap, query: &QueryMap) -> Result<(), AppError> {
    if is_authorized(headers, query, &state.token) {
        Ok(())
    } else {
        Err(AppError::Unauthorized)
    }
}

async fn require_qbit(state: &AppState) -> Result<QbitClient, AppError> {
    state
        .qbit
        .read()
        .await
        .clone()
        .ok_or_else(|| AppError::ServiceUnavailable(NOT_CONFIGURED.to_string()))
}

async fn magnet_defaults(state: &AppState) -> (String, Vec<String>) {
    let config = state.config.read().await;
    (
        config.default_category.clone(),
        config.default_tags.clone(),
    )
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Cursor, Read},
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    use axum::{
        body::Body,
        extract::{Query, State},
        http::{header, Request},
        response::IntoResponse,
        Router,
    };
    use http_body_util::BodyExt;
    use tokio::sync::RwLock;
    use tower::ServiceExt;

    use super::*;
    use crate::{config::Config, qbit::QbitClient};

    const TOKEN: &str = "test-token-1234567890";
    const HASH: &str = "dc555f7a26f1acae38a18edc04e53588ade33051";
    const OTHER_HASH: &str = "1111111111111111111111111111111111111111";

    static NEXT_CONFIG: AtomicU64 = AtomicU64::new(0);

    fn test_config_path() -> PathBuf {
        std::env::temp_dir().join(format!(
            "remagnet-bridge-test-{}-{}.json",
            std::process::id(),
            NEXT_CONFIG.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[derive(Clone)]
    struct FakeQbit {
        completed: bool,
    }

    fn torrent_json(hash: &str, name: &str, completed: bool) -> serde_json::Value {
        let other = hash != HASH;
        json!({
            "hash": hash,
            "name": name,
            "progress": if completed { 1.0 } else if other { 0.25 } else { 0.5 },
            "amount_left": if completed { 0 } else { 512 },
            "size": 1024,
            "state": if completed { "seeding" } else if other { "downloading" } else { "stalledDL" },
            "dlspeed": 10,
            "upspeed": 5,
            "eta": 60,
            "ratio": 1.5,
            "category": if other { "films" } else { "Remagnet" },
            "tags": if other { "other, cross-seed" } else { "Remagnet, seedbox" },
            "num_seeds": 3,
            "num_leechs": 2,
        })
    }

    async fn fake_app(State(state): State<FakeQbit>, request: Request<Body>) -> Response {
        let authorized = request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            == Some("Bearer qbt_test");
        if !authorized {
            return (StatusCode::UNAUTHORIZED, "missing auth").into_response();
        }

        let method = request.method().clone();
        let path = request.uri().path().to_string();
        match (method.as_str(), path.as_str()) {
            ("GET", "/api/v2/app/version") => "5.3.0".into_response(),
            ("GET", "/api/v2/app/webapiVersion") => "2.16.2".into_response(),
            ("GET", "/api/v2/torrents/info") => {
                let Query(query) = Query::<QueryMap>::try_from_uri(request.uri()).unwrap();
                let torrents = match query.get("hashes") {
                    Some(hashes) if hashes.eq_ignore_ascii_case(HASH) => vec![torrent_json(
                        HASH,
                        "Test Torrent",
                        state.completed,
                    )],
                    Some(hashes) if hashes.eq_ignore_ascii_case(OTHER_HASH) => {
                        vec![torrent_json(OTHER_HASH, "Other Torrent", false)]
                    }
                    Some(_) => Vec::new(),
                    None => vec![
                        torrent_json(HASH, "Test Torrent", state.completed),
                        torrent_json(OTHER_HASH, "Other Torrent", false),
                    ],
                };
                Json(json!(torrents)).into_response()
            }
            ("GET", "/api/v2/torrents/categories") => Json(json!({})).into_response(),
            ("GET", "/api/v2/torrents/tags") => Json(json!([])).into_response(),
            ("POST", "/api/v2/torrents/createCategory") => "".into_response(),
            ("POST", "/api/v2/torrents/createTags") => "".into_response(),
            ("POST", "/api/v2/torrents/add") => "Ok.".into_response(),
            ("POST", "/api/v2/torrents/delete") => "Ok.".into_response(),
            ("GET", "/api/v2/torrents/files") => Json(json!([
                {
                    "index": 0,
                    "name": "Test Torrent/readme.txt",
                    "size": 5,
                    "progress": 1.0,
                },
                {
                    "index": 1,
                    "name": "Test Torrent/empty.txt",
                    "size": 0,
                    "progress": 1.0,
                }
            ]))
            .into_response(),
            ("GET", "/api/v2/torrents/downloadFile") => {
                let Query(query) = Query::<QueryMap>::try_from_uri(request.uri()).unwrap();
                if query.get("hash").map(String::as_str) != Some(HASH) {
                    return (StatusCode::BAD_REQUEST, "bad hash").into_response();
                }
                match query.get("file").map(String::as_str) {
                    Some("Test Torrent/readme.txt") => "hello".into_response(),
                    Some("Test Torrent/empty.txt") => Body::empty().into_response(),
                    _ => (StatusCode::NOT_FOUND, "no file").into_response(),
                }
            }
            _ => (StatusCode::NOT_FOUND, "not found").into_response(),
        }
    }

    async fn start_fake(completed: bool) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new()
            .fallback(fake_app)
            .with_state(FakeQbit { completed });
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{address}")
    }

    fn config_for(base_url: &str) -> Config {
        Config {
            qbit_base_url: base_url.to_string(),
            qbit_api_key: "qbt_test".to_string(),
            qbit_username: String::new(),
            qbit_password: String::new(),
            default_category: "remagnet".to_string(),
            default_tags: vec!["remagnet".to_string()],
        }
    }

    fn app_from_config(config: Config, with_client: bool, config_path: PathBuf) -> Router {
        let qbit = if with_client {
            Some(QbitClient::new(&config).unwrap())
        } else {
            None
        };
        let state = Arc::new(AppState {
            config_path,
            config: RwLock::new(config),
            qbit: RwLock::new(qbit),
            token: TOKEN.to_string(),
            pairings: std::sync::Mutex::new(crate::pairing::PairingStore::default()),
        });
        router(state)
    }

    async fn app_with_filter(completed: bool, category: &str, tags: &[&str]) -> Router {
        let base_url = start_fake(completed).await;
        let mut config = config_for(&base_url);
        config.default_category = category.to_string();
        config.default_tags = tags.iter().map(|tag| tag.to_string()).collect();
        app_from_config(config, true, test_config_path())
    }

    async fn app(completed: bool) -> Router {
        app_with_filter(completed, "remagnet", &["remagnet"]).await
    }

    fn request(uri: &str) -> Request<Body> {
        Request::builder()
            .uri(uri)
            .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test]
    async fn wordmark_font_is_public() {
        let app = app(true).await;

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/assets/departure-mono.woff2")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "font/woff2");
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert!(body.len() > 10_000);
    }

    #[tokio::test]
    async fn icon_is_public_svg() {
        let app = app(true).await;

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/icon.svg")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/svg+xml");
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert!(body.starts_with(b"<svg"));
    }

    #[tokio::test]
    async fn health_is_public_but_api_requires_the_token() {
        let app = app(true).await;

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/healthz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let response = app.oneshot(request("/api/health")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["appVersion"], "5.3.0");
        assert_eq!(body["clientLabel"], "qBittorrent");
        assert_eq!(body["capabilities"]["pauseOnAdd"], true);
        assert_eq!(body["defaultCategory"], "remagnet");
        assert_eq!(body["defaultTags"], json!(["remagnet"]));
    }

    #[tokio::test]
    async fn unconfigured_proxy_reports_service_unavailable() {
        let base_url = start_fake(true).await;
        let mut config = config_for(&base_url);
        config.qbit_api_key.clear();
        let app = app_from_config(config, false, test_config_path());

        let response = app
            .clone()
            .oneshot(request("/api/health"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"], NOT_CONFIGURED);

        let response = app.oneshot(request("/api/torrents")).await.unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn streams_a_zip_with_the_torrent_files() {
        let response = app(true)
            .await
            .oneshot(request(&format!("/archive/{HASH}")))
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/zip"
        );
        let disposition = response
            .headers()
            .get(header::CONTENT_DISPOSITION)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(disposition.contains("Test Torrent.zip"));

        let body = response.into_body().collect().await.unwrap().to_bytes();
        let mut archive = zip::ZipArchive::new(Cursor::new(body)).unwrap();
        assert_eq!(archive.len(), 2);

        let mut readme = String::new();
        archive
            .by_name("Test Torrent/readme.txt")
            .unwrap()
            .read_to_string(&mut readme)
            .unwrap();
        assert_eq!(readme, "hello");
        assert!(archive.by_name("Test Torrent/empty.txt").is_ok());
    }

    #[tokio::test]
    async fn rejects_incomplete_torrents_and_bad_hashes() {
        let response = app(false)
            .await
            .oneshot(request(&format!("/archive/{HASH}")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);

        let response = app(true)
            .await
            .oneshot(request("/archive/not-a-hash"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn config_api_never_returns_secrets_and_includes_magnet_defaults() {
        let response = app(true)
            .await
            .oneshot(request("/api/config"))
            .await
            .unwrap();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["hasApiKey"], true);
        assert_eq!(body["defaultCategory"], "remagnet");
        assert_eq!(body["defaultTags"], json!(["remagnet"]));
        assert!(body.get("qbitApiKey").is_none());
    }

    #[tokio::test]
    async fn saving_credentials_activates_the_client() {
        let base_url = start_fake(true).await;
        let config_path = test_config_path();
        let mut config = config_for(&base_url);
        config.qbit_api_key.clear();
        let app = app_from_config(config, false, config_path.clone());

        let response = app
            .clone()
            .oneshot(request("/api/health"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/config")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                    .body(Body::from(
                        json!({
                            "qbitBaseUrl": base_url,
                            "qbitApiKey": "qbt_test",
                            "defaultCategory": "remagnet",
                            "defaultTags": ["remagnet"],
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["hasApiKey"], true);

        let response = app.oneshot(request("/api/health")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let _ = std::fs::remove_file(config_path);
    }

    #[tokio::test]
    async fn lists_only_relevant_torrents() {
        let response = app(true)
            .await
            .oneshot(request("/api/torrents"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let torrents = body["torrents"].as_array().unwrap();
        assert_eq!(torrents.len(), 1);
        assert_eq!(torrents[0]["hash"], HASH);
        assert_eq!(torrents[0]["state"], "seeding");
        assert_eq!(torrents[0]["tags"], json!(["Remagnet", "seedbox"]));
        assert_eq!(torrents[0]["downloadSpeed"], 10);
        assert_eq!(torrents[0]["size"], 1024);
    }

    #[tokio::test]
    async fn empty_magnet_defaults_list_every_torrent() {
        let response = app_with_filter(true, "", &[])
            .await
            .oneshot(request("/api/torrents"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["torrents"].as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn gets_torrents_by_hash_without_the_relevance_filter() {
        let app = app(true).await;

        let response = app
            .clone()
            .oneshot(request(&format!("/api/torrents/{OTHER_HASH}")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["hash"], OTHER_HASH);
        assert_eq!(body["category"], "films");

        let response = app
            .clone()
            .oneshot(request("/api/torrents/not-a-hash"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let response = app
            .oneshot(request("/api/torrents/2222222222222222222222222222222222222222"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    fn post_json(uri: &str, body: serde_json::Value) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    #[tokio::test]
    async fn adding_a_torrent_uses_the_proxy_defaults() {
        let app = app_with_filter(true, "remagnet", &["remagnet", "nas"]).await;
        let magnet = format!("magnet:?xt=urn:btih:{HASH}&dn=Example");

        let response = app
            .oneshot(post_json(
                "/api/torrents",
                json!({ "urls": [magnet], "paused": true }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["added"], 1);
        assert_eq!(body["hashes"], json!([HASH]));
        assert_eq!(body["category"], "remagnet");
        assert_eq!(body["tags"], json!(["remagnet", "nas"]));
    }

    #[tokio::test]
    async fn adding_without_urls_is_rejected() {
        let response = app(true)
            .await
            .oneshot(post_json("/api/torrents", json!({ "urls": [] })))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    fn delete_request(uri: &str) -> Request<Body> {
        Request::builder()
            .method("DELETE")
            .uri(uri)
            .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test]
    async fn deletes_only_relevant_torrents() {
        let app = app(true).await;

        let response = app
            .clone()
            .oneshot(delete_request(&format!("/api/torrents/{OTHER_HASH}")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        let response = app
            .clone()
            .oneshot(delete_request(&format!(
                "/api/torrents/{HASH}?deleteFiles=true"
            )))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);

        let response = app
            .oneshot(delete_request(&format!(
                "/api/torrents/{HASH}?deleteFiles=maybe"
            )))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn pairing_mints_only_with_the_bridge_token() {
        let app = app(true).await;

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pair")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pair")
                    .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({ "url": "http://127.0.0.1:8080" }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );

        let body = response.into_body().collect().await.unwrap().to_bytes();
        let created: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(created["url"], "http://127.0.0.1:8080");
        assert!(created["uri"]
            .as_str()
            .unwrap()
            .starts_with("remagnet://pair?url=http%3A%2F%2F127.0.0.1%3A8080"));
        assert!(created["svg"].as_str().unwrap().starts_with("<svg"));
    }

    #[tokio::test]
    async fn pairing_rejects_plain_http_for_remote_origins() {
        let response = app(true)
            .await
            .oneshot(post_json(
                "/api/pair",
                json!({ "url": "http://proxy.example.com" }),
            ))
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"], "Pairing needs an HTTPS Remagnet Proxy URL.");
    }

    struct ClaimedPairing {
        id: String,
        proof: String,
        payload: serde_json::Value,
    }

    async fn claim_pairing(app: &Router) -> ClaimedPairing {
        use aes_gcm::{
            aead::{Aead, KeyInit},
            Aes256Gcm, Nonce,
        };
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

        let response = app
            .clone()
            .oneshot(post_json(
                "/api/pair",
                json!({ "url": "http://127.0.0.1:8080" }),
            ))
            .await
            .unwrap();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let created: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let id = created["id"].as_str().unwrap().to_string();
        let code = created["code"].as_str().unwrap().to_string();
        let secret: [u8; 32] = URL_SAFE_NO_PAD
            .decode(code.as_bytes())
            .unwrap()
            .try_into()
            .unwrap();

        let proof = crate::pairing::proof(&secret);
        let response = app
            .clone()
            .oneshot(post_json(
                "/api/pair/claim",
                json!({ "id": id, "proof": proof }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let body = response.into_body().collect().await.unwrap().to_bytes();
        let encrypted: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let nonce = URL_SAFE_NO_PAD
            .decode(encrypted["iv"].as_str().unwrap())
            .unwrap();
        let ciphertext = URL_SAFE_NO_PAD
            .decode(encrypted["data"].as_str().unwrap())
            .unwrap();
        let key = crate::pairing::derive_key(&secret, &id);
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let plaintext = cipher
            .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&plaintext).unwrap();

        ClaimedPairing { id, proof, payload }
    }

    #[tokio::test]
    async fn pairing_claim_returns_only_the_proxy_token_once() {
        let app = app(true).await;
        let claimed = claim_pairing(&app).await;

        assert_eq!(claimed.payload["version"], 2);
        assert_eq!(claimed.payload["proxyToken"], TOKEN);
        assert!(claimed.payload.get("qbitBaseUrl").is_none());
        assert!(claimed.payload.get("authMode").is_none());
        assert!(claimed.payload.get("apiKey").is_none());
        assert!(claimed.payload.get("username").is_none());
        assert!(claimed.payload.get("password").is_none());

        let replay = app
            .oneshot(post_json(
                "/api/pair/claim",
                json!({ "id": claimed.id, "proof": claimed.proof }),
            ))
            .await
            .unwrap();
        assert_eq!(replay.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn unknown_hashes_are_not_found() {
        // A syntactically valid hash that qBittorrent does not know.
        let response = app(true)
            .await
            .oneshot(request(
                "/api/torrents/3333333333333333333333333333333333333333",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn delete_files_parsing_is_strict() {
        assert!(!parse_delete_files(&QueryMap::new()).unwrap());
        assert!(!parse_delete_files(&HashMap::from([
            ("deleteFiles".to_string(), "false".to_string())
        ]))
        .unwrap());
        assert!(parse_delete_files(&HashMap::from([(
            "deleteFiles".to_string(),
            "TRUE".to_string()
        )]))
        .unwrap());
        assert!(parse_delete_files(&HashMap::from([(
            "deleteFiles".to_string(),
            "1".to_string()
        )]))
        .is_err());
    }
}
