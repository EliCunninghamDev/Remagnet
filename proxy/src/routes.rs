use std::{
    collections::HashMap,
    sync::{atomic::AtomicBool, Arc, Mutex},
};

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio_util::io::ReaderStream;
use tower_http::{set_header::SetResponseHeaderLayer, trace::TraceLayer};

use crate::{
    auth,
    auth_routes::{require_admin, require_archive_auth, require_device_or_admin},
    backend::{
        matches_torrent_filter, torrent_completed, AddTorrentRequest, AddTorrentResult,
        TorrentBackend, TorrentList, TorrentSummary,
    },
    config::{save, ConfigUpdate, PublicConfig},
    error::AppError,
    zipstream::{content_disposition, validate_hash, write_zip, zip_filename, ZipStream},
    AppState,
};

type QueryMap = HashMap<String, String>;

/// The version of the client-facing HTTP contract.
///
/// Bump this only for a breaking change to the JSON shapes or routes; clients
/// can read it from `GET /healthz` and `GET /api/health`.
pub const API_VERSION: u32 = 1;

const NOT_CONFIGURED: &str =
    "No torrent client is configured yet. Open the Remagnet Proxy page to set it up.";

pub fn router(state: Arc<AppState>) -> Router {
    let api = Router::new()
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
        .route("/api/archive/{hash}/ticket", post(create_archive_ticket))
        .route("/archive/{hash}", get(archive))
        .merge(crate::auth_routes::router())
        // Authenticated API responses can carry secrets (tokens, pairings,
        // configuration), so no browser or intermediary may cache them.
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ));

    Router::new()
        .route("/", get(ui))
        .route("/icon.svg", get(icon))
        .route("/assets/departure-mono.woff2", get(wordmark_font))
        .route("/healthz", get(healthz))
        .merge(api)
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

/// The application mark, served for the proxy page's favicon.
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
        "service": "remagnet-proxy",
        "version": env!("CARGO_PKG_VERSION"),
        "apiVersion": API_VERSION,
    }))
}

async fn api_health(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    require_device_or_admin(&state, &headers).await?;
    let backend = require_backend(&state).await?;
    let (default_category, default_tags) = magnet_defaults(&state).await;
    let health = backend.test_connection().await?;

    Ok(Json(json!({
        "ok": true,
        "clientLabel": health.client_label,
        "appVersion": health.app_version,
        "webApiVersion": health.web_api_version,
        "apiVersion": API_VERSION,
        "proxyVersion": env!("CARGO_PKG_VERSION"),
        "capabilities": health.capabilities,
        "defaultCategory": default_category,
        "defaultTags": default_tags,
    })))
}

async fn get_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<PublicConfig>, AppError> {
    require_admin(&state, &headers).await?;
    let config = state.config.read().await;
    Ok(Json(PublicConfig::from(&*config)))
}

async fn put_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(update): Json<ConfigUpdate>,
) -> Result<Json<PublicConfig>, AppError> {
    require_admin(&state, &headers).await?;

    let mut candidate = state.config.read().await.clone();
    candidate
        .apply_update(update)
        .map_err(AppError::BadRequest)?;

    // Build the client before touching the file so an invalid URL or HTTP
    // client setup never replaces a working configuration. A proxy without
    // credentials stays bootable with no client until setup is completed.
    let backend = TorrentBackend::from_config(&candidate).map_err(AppError::internal)?;
    save(&state.config_path, &candidate)
        .await
        .map_err(AppError::internal)?;

    {
        let mut config = state.config.write().await;
        let mut client = state.backend.write().await;
        *config = candidate.clone();
        *client = backend;
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
/// proxy page does not need a JavaScript QR library and the code stays out of
/// the extension's hands.
async fn create_pairing(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Option<Json<CreatePairingRequest>>,
) -> Result<impl IntoResponse, AppError> {
    require_admin(&state, &headers).await?;

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
/// Only a fallback for API clients: the proxy page sends `location.origin`,
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
#[serde(rename_all = "camelCase")]
struct ClaimPairing {
    id: String,
    proof: String,
    #[serde(default)]
    device_name: Option<String>,
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

    // Pairing is a second enrolment path: it mints a fresh device token and
    // never needs the administrator's second factor. The token is only shown
    // once, inside the encrypted payload.
    let (token, record) = auth::mint_device(claim.device_name.as_deref().or(Some("Paired device")))
        .map_err(AppError::internal)?;
    {
        let mut data = state.auth.write().await;
        data.devices.push(record);
        auth::save(&state.auth_path, &data).map_err(AppError::internal)?;
    }

    let payload = PairingPayload {
        version: 2,
        proxy_token: &token,
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
) -> Result<StatusCode, AppError> {
    require_admin(&state, &headers).await?;

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
) -> Result<Json<TorrentList>, AppError> {
    require_device_or_admin(&state, &headers).await?;
    let (default_category, default_tags) = magnet_defaults(&state).await;
    let backend = require_backend(&state).await?;

    let torrents = backend
        .list_torrents()
        .await?
        .into_iter()
        .filter(|torrent| matches_torrent_filter(torrent, &default_category, &default_tags))
        .collect();

    Ok(Json(TorrentList { torrents }))
}

async fn get_torrent(
    State(state): State<Arc<AppState>>,
    Path(hash): Path<String>,
    headers: HeaderMap,
) -> Result<Json<TorrentSummary>, AppError> {
    require_device_or_admin(&state, &headers).await?;
    validate_hash(&hash)?;
    let backend = require_backend(&state).await?;

    match backend.get_torrent(&hash).await? {
        Some(torrent) => Ok(Json(torrent)),
        None => Err(AppError::NotFound(
            "Torrent not found in qBittorrent.".to_string(),
        )),
    }
}

async fn add_torrent(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<AddTorrentRequest>,
) -> Result<Json<AddTorrentResult>, AppError> {
    require_device_or_admin(&state, &headers).await?;
    let (default_category, default_tags) = magnet_defaults(&state).await;
    let backend = require_backend(&state).await?;

    // Clients cannot choose a category or tag: the proxy always applies its
    // configured defaults so every client agrees on what Remagnet owns.
    let result = backend
        .add_torrents(
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
    require_device_or_admin(&state, &headers).await?;
    validate_hash(&hash)?;
    let delete_files = parse_delete_files(&query)?;
    let (default_category, default_tags) = magnet_defaults(&state).await;
    let backend = require_backend(&state).await?;

    // Only torrents matching the proxy's filter are deletable, so a client
    // cannot remove an unrelated torrent from a shared qBittorrent instance.
    let allowed = backend
        .get_torrent(&hash)
        .await?
        .is_some_and(|torrent| matches_torrent_filter(&torrent, &default_category, &default_tags));
    if !allowed {
        return Err(AppError::NotFound("Torrent not found.".to_string()));
    }

    backend.remove_torrent(&hash, delete_files).await?;
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

/// Mint a short-lived, single-use ticket for one archive download.
///
/// Devices use this instead of putting their long-lived token in a download
/// URL, where it would leak into history and logs.
async fn create_archive_ticket(
    State(state): State<Arc<AppState>>,
    Path(hash): Path<String>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    require_device_or_admin(&state, &headers).await?;
    validate_hash(&hash)?;
    let (default_category, default_tags) = magnet_defaults(&state).await;
    let backend = require_backend(&state).await?;

    // Ticket minting obeys the same ownership filter as downloading and
    // deleting: a hash outside the configured category/tags must not even get
    // a short-lived credential.
    let allowed = backend
        .get_torrent(&hash)
        .await?
        .is_some_and(|torrent| matches_torrent_filter(&torrent, &default_category, &default_tags));
    if !allowed {
        return Err(AppError::NotFound("Torrent not found.".to_string()));
    }

    let (ticket, expires_in) = state
        .archive_tickets
        .lock()
        .map_err(|_| AppError::internal("archive ticket state is unavailable"))?
        .create(&hash)
        .map_err(AppError::internal)?;

    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({ "ticket": ticket, "expiresIn": expires_in })),
    ))
}

async fn archive(
    State(state): State<Arc<AppState>>,
    Path(hash): Path<String>,
    headers: HeaderMap,
    Query(query): Query<QueryMap>,
) -> Result<Response, AppError> {
    require_archive_auth(&state, &headers, &query, &hash).await?;
    validate_hash(&hash)?;

    let (default_category, default_tags) = magnet_defaults(&state).await;
    let backend = require_backend(&state).await?;
    let torrent = backend.archive_torrent(&hash).await?;
    if !torrent.matches_filter(&default_category, &default_tags) {
        return Err(AppError::NotFound("Torrent not found.".to_string()));
    }
    if !torrent_completed(&torrent) {
        return Err(AppError::Conflict(format!(
            "{} is not complete yet ({}%).",
            torrent.name,
            (torrent.progress.clamp(0.0, 1.0) * 100.0).round() as u32
        )));
    }

    let mut files = backend.files(&hash).await?;
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
    let task_hash = torrent.hash.clone();

    tokio::spawn(async move {
        if let Err(error) = write_zip(writer, backend, torrent, files, task_success).await {
            // `{error:#}` keeps the whole anyhow chain: the top-level context
            // alone ("could not read …") hides the actual client failure.
            let detail = format!("{error:#}");
            tracing::warn!(hash = %task_hash, error = %detail, "archive stream ended early");
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

async fn require_backend(state: &AppState) -> Result<TorrentBackend, AppError> {
    state
        .backend
        .read()
        .await
        .clone()
        .ok_or_else(|| AppError::ServiceUnavailable(NOT_CONFIGURED.to_string()))
}

async fn magnet_defaults(state: &AppState) -> (String, Vec<String>) {
    let config = state.config.read().await;
    (config.default_category.clone(), config.default_tags.clone())
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Cursor, Read},
        path::PathBuf,
        sync::{
            atomic::{AtomicU64, Ordering},
            Arc, Mutex, OnceLock,
        },
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
    use crate::{
        auth::{self, AdminAccount, AuthData},
        config::Config,
        pairing::PairingStore,
    };

    const ADMIN_USER: &str = "admin";
    const ADMIN_PASSWORD: &str = "correct horse battery staple";
    const HASH: &str = "dc555f7a26f1acae38a18edc04e53588ade33051";
    const OTHER_HASH: &str = "1111111111111111111111111111111111111111";

    static NEXT_CONFIG: AtomicU64 = AtomicU64::new(0);

    fn test_config_path() -> PathBuf {
        std::env::temp_dir().join(format!(
            "remagnet-proxy-test-{}-{}.json",
            std::process::id(),
            NEXT_CONFIG.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn password_hash() -> &'static str {
        static HASH: OnceLock<String> = OnceLock::new();
        HASH.get_or_init(|| auth::hash_password(ADMIN_PASSWORD).unwrap())
    }

    struct TestApp {
        router: Router,
        state: Arc<AppState>,
        device_token: String,
        admin_cookie: String,
        _directory: tempfile::TempDir,
    }

    impl TestApp {
        fn admin_request(&self, uri: &str) -> Request<Body> {
            Request::builder()
                .uri(uri)
                .header(
                    header::COOKIE,
                    format!("remagnet_session={}", self.admin_cookie),
                )
                .body(Body::empty())
                .unwrap()
        }

        fn device_request(&self, uri: &str) -> Request<Body> {
            Request::builder()
                .uri(uri)
                .header(
                    header::AUTHORIZATION,
                    format!("Bearer {}", self.device_token),
                )
                .body(Body::empty())
                .unwrap()
        }

        fn admin_json(&self, method: &str, uri: &str, body: serde_json::Value) -> Request<Body> {
            Request::builder()
                .method(method)
                .uri(uri)
                .header(header::CONTENT_TYPE, "application/json")
                .header(
                    header::COOKIE,
                    format!("remagnet_session={}", self.admin_cookie),
                )
                .body(Body::from(body.to_string()))
                .unwrap()
        }

        fn device_json(&self, method: &str, uri: &str, body: serde_json::Value) -> Request<Body> {
            Request::builder()
                .method(method)
                .uri(uri)
                .header(header::CONTENT_TYPE, "application/json")
                .header(
                    header::AUTHORIZATION,
                    format!("Bearer {}", self.device_token),
                )
                .body(Body::from(body.to_string()))
                .unwrap()
        }

        fn admin_delete(&self, uri: &str) -> Request<Body> {
            Request::builder()
                .method("DELETE")
                .uri(uri)
                .header(
                    header::COOKIE,
                    format!("remagnet_session={}", self.admin_cookie),
                )
                .body(Body::empty())
                .unwrap()
        }
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
                    Some(hashes) if hashes.eq_ignore_ascii_case(HASH) => {
                        vec![torrent_json(HASH, "Test Torrent", state.completed)]
                    }
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

    /// Minimal Transmission JSON-RPC daemon for route-level tests.
    ///
    /// It enforces the session-id handshake and serves torrent metadata plus a
    /// single file whose bytes live on the mounted downloads volume.
    async fn fake_transmission(
        State(torrents): State<Vec<serde_json::Value>>,
        request: Request<Body>,
    ) -> Response {
        const SESSION: &str = "routes-session";

        let provided = request
            .headers()
            .get("x-transmission-session-id")
            .and_then(|value| value.to_str().ok());
        if provided != Some(SESSION) {
            return (
                StatusCode::CONFLICT,
                [("x-transmission-session-id", SESSION)],
            )
                .into_response();
        }

        let body = request.into_body().collect().await.unwrap().to_bytes();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        match payload["method"].as_str().unwrap_or_default() {
            "session-get" => Json(json!({
                "result": "success",
                "arguments": { "version": "4.0.6", "rpc-version": 17 }
            }))
            .into_response(),
            "torrent-get" => {
                let ids = payload["arguments"]
                    .get("ids")
                    .and_then(|value| value.as_array());
                let torrents = torrents
                    .iter()
                    .filter(|torrent| match ids {
                        None => true,
                        Some(ids) => ids.iter().any(|id| {
                            id.as_str().is_some_and(|id| {
                                torrent["hashString"]
                                    .as_str()
                                    .is_some_and(|hash| hash.eq_ignore_ascii_case(id))
                            })
                        }),
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                Json(json!({
                    "result": "success",
                    "arguments": { "torrents": torrents }
                }))
                .into_response()
            }
            "torrent-remove" => {
                Json(json!({ "result": "success", "arguments": {} })).into_response()
            }
            _ => (StatusCode::NOT_FOUND, "not found").into_response(),
        }
    }

    fn transmission_torrent(
        hash: &str,
        name: &str,
        labels: &[&str],
        completed: bool,
    ) -> serde_json::Value {
        json!({
            "hashString": hash,
            "name": name,
            "status": if completed { 6 } else { 4 },
            "percentDone": if completed { 1.0 } else { 0.25 },
            "metadataPercentComplete": 1.0,
            "totalSize": 1024,
            "sizeWhenDone": 1024,
            "leftUntilDone": if completed { 0 } else { 512 },
            "rateDownload": 10,
            "rateUpload": 5,
            "eta": 60,
            "uploadRatio": 1.5,
            "labels": labels,
            "peersSendingToUs": 3,
            "peersGettingFromUs": 2,
            "error": 0,
            "errorString": "",
            "addedDate": 0,
            "downloadDir": "/downloads",
            "files": [
                { "name": "Test Torrent/readme.txt", "length": 5, "bytesCompleted": 5 }
            ],
            "fileStats": [ { "wanted": true } ],
        })
    }

    async fn start_fake_transmission(torrents: Vec<serde_json::Value>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new()
            .fallback(fake_transmission)
            .with_state(torrents);
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{address}")
    }

    async fn app_with_transmission(
        downloads_dir: &str,
        default_category: &str,
        default_tags: &[&str],
    ) -> TestApp {
        let base_url = start_fake_transmission(vec![
            transmission_torrent(HASH, "Test Torrent", &["Remagnet"], true),
            transmission_torrent(OTHER_HASH, "Other Torrent", &["other"], true),
        ])
        .await;

        let mut config = config_for(&base_url);
        config.client_kind = crate::backend::ClientKind::Transmission;
        config.api_key.clear();
        config.downloads_dir = downloads_dir.to_string();
        config.default_category = default_category.to_string();
        config.default_tags = default_tags.iter().map(|tag| tag.to_string()).collect();
        app_from_config(config, true, test_config_path())
    }

    fn fixture_downloads() -> (tempfile::TempDir, String) {
        let directory = tempfile::tempdir().unwrap();
        let downloads = directory.path().join("downloads");
        std::fs::create_dir_all(downloads.join("Test Torrent")).unwrap();
        std::fs::write(downloads.join("Test Torrent/readme.txt"), b"hello").unwrap();
        let path = downloads.to_string_lossy().to_string();
        (directory, path)
    }

    #[tokio::test]
    async fn transmission_reports_health_and_lists_labelled_torrents() {
        let (_directory, downloads) = fixture_downloads();
        let app = app_with_transmission(&downloads, "remagnet", &["remagnet"]).await;

        let response = app
            .router
            .clone()
            .oneshot(app.device_request("/api/health"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["clientLabel"], "Transmission");
        assert_eq!(body["appVersion"], "4.0.6");
        assert_eq!(body["webApiVersion"], "17");
        assert_eq!(body["capabilities"]["pauseOnAdd"], true);
        assert_eq!(body["capabilities"]["archiveDownload"], true);
        assert_eq!(body["capabilities"]["categories"], false);
        assert_eq!(body["capabilities"]["tags"], true);

        let response = app
            .router
            .clone()
            .oneshot(app.device_request("/api/torrents"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let torrents = body["torrents"].as_array().unwrap();
        assert_eq!(torrents.len(), 1);
        assert_eq!(torrents[0]["hash"], HASH);
        assert_eq!(torrents[0]["name"], "Test Torrent");
        assert_eq!(torrents[0]["tags"], json!(["Remagnet"]));
        assert_eq!(torrents[0]["category"], "");
        assert_eq!(torrents[0]["state"], "seeding");
        assert_eq!(torrents[0]["size"], 1024);
    }

    #[tokio::test]
    async fn transmission_rejects_unrelated_torrents_for_delete_and_archive() {
        let (_directory, downloads) = fixture_downloads();
        let app = app_with_transmission(&downloads, "remagnet", &["remagnet"]).await;

        let response = app
            .router
            .clone()
            .oneshot(app.admin_delete(&format!("/api/torrents/{OTHER_HASH}")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        let response = app
            .router
            .clone()
            .oneshot(app.device_json(
                "POST",
                &format!("/api/archive/{OTHER_HASH}/ticket"),
                json!({}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        let response = app
            .router
            .clone()
            .oneshot(app.admin_request(&format!("/archive/{OTHER_HASH}")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"], "Torrent not found.");

        // A related torrent is still removable through the same surface.
        let response = app
            .router
            .clone()
            .oneshot(app.admin_delete(&format!("/api/torrents/{HASH}?deleteFiles=true")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn transmission_archives_bytes_from_the_downloads_volume() {
        let (_directory, downloads) = fixture_downloads();
        let app = app_with_transmission(&downloads, "remagnet", &["remagnet"]).await;

        let response = app
            .router
            .clone()
            .oneshot(app.admin_request(&format!("/archive/{HASH}")))
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
        assert_eq!(archive.len(), 1);
        let mut bytes = Vec::new();
        archive
            .by_name("Test Torrent/readme.txt")
            .unwrap()
            .read_to_end(&mut bytes)
            .unwrap();
        assert_eq!(bytes, b"hello");
        assert_eq!(
            bytes,
            std::fs::read(std::path::Path::new(&downloads).join("Test Torrent/readme.txt"))
                .unwrap()
        );
    }

    fn config_for(base_url: &str) -> Config {
        Config {
            client_kind: crate::backend::ClientKind::Qbittorrent,
            base_url: base_url.to_string(),
            api_key: "qbt_test".to_string(),
            username: String::new(),
            password: String::new(),
            downloads_dir: String::new(),
            client_downloads_dir: String::new(),
            default_category: "remagnet".to_string(),
            default_tags: vec!["remagnet".to_string()],
        }
    }

    fn app_from_config(config: Config, with_client: bool, _config_path: PathBuf) -> TestApp {
        let directory = tempfile::tempdir().unwrap();
        let config_path = directory.path().join("config.json");
        let auth_path = directory.path().join("auth.json");
        let qbit = if with_client {
            TorrentBackend::from_config(&config).unwrap()
        } else {
            None
        };
        let (device_token, record) = auth::mint_device(Some("Test device")).unwrap();
        let data = AuthData {
            admin: Some(AdminAccount {
                username: ADMIN_USER.to_string(),
                password_hash: password_hash().to_string(),
                totp_secret: None,
                totp_last_step: None,
                recovery_code_hashes: Vec::new(),
            }),
            devices: vec![record],
        };
        let state = Arc::new(AppState {
            config_path,
            config: RwLock::new(config),
            backend: RwLock::new(qbit),
            auth_path,
            auth: RwLock::new(data),
            setup_code: None,
            sessions: Mutex::new(auth::SessionStore::default()),
            pending_totp: Mutex::new(auth::PendingTotpStore::default()),
            archive_tickets: Mutex::new(auth::ArchiveTicketStore::default()),
            rate_limiter: Mutex::new(auth::LoginRateLimiter::default()),
            pairings: Mutex::new(PairingStore::default()),
        });
        let admin_cookie = state.sessions.lock().unwrap().create(ADMIN_USER);
        TestApp {
            router: router(Arc::clone(&state)),
            state,
            device_token,
            admin_cookie,
            _directory: directory,
        }
    }

    async fn app_with_filter(completed: bool, category: &str, tags: &[&str]) -> TestApp {
        let base_url = start_fake(completed).await;
        let mut config = config_for(&base_url);
        config.default_category = category.to_string();
        config.default_tags = tags.iter().map(|tag| tag.to_string()).collect();
        app_from_config(config, true, test_config_path())
    }

    async fn app(completed: bool) -> TestApp {
        app_with_filter(completed, "remagnet", &["remagnet"]).await
    }

    #[tokio::test]
    async fn wordmark_font_is_public() {
        let app = app(true).await;

        let response = app
            .router
            .clone()
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
            .router
            .clone()
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
    async fn health_is_public_but_api_accepts_a_device_or_admin() {
        let app = app(true).await;

        let response = app
            .router
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
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["ok"], true);
        assert_eq!(body["service"], "remagnet-proxy");
        assert_eq!(body["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(body["apiVersion"], API_VERSION);

        let response = app
            .router
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
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");

        let response = app
            .router
            .clone()
            .oneshot(app.device_request("/api/health"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["appVersion"], "5.3.0");
        assert_eq!(body["clientLabel"], "qBittorrent");
        assert_eq!(body["apiVersion"], API_VERSION);
        assert_eq!(body["proxyVersion"], env!("CARGO_PKG_VERSION"));
        assert_eq!(body["capabilities"]["pauseOnAdd"], true);
        assert_eq!(body["defaultCategory"], "remagnet");
        assert_eq!(body["defaultTags"], json!(["remagnet"]));

        let response = app
            .router
            .clone()
            .oneshot(app.admin_request("/api/health"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn api_responses_disable_caching() {
        let app = app(true).await;

        for uri in ["/api/health", "/api/auth/status", "/api/torrents"] {
            let response = app
                .router
                .clone()
                .oneshot(app.device_request(uri))
                .await
                .unwrap();
            assert_eq!(
                response.headers().get(header::CACHE_CONTROL).unwrap(),
                "no-store",
                "{uri} must not be cached"
            );
        }

        // Public pages keep their own caching policy rather than inheriting
        // the API one.
        let response = app
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/healthz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(!response.headers().contains_key(header::CACHE_CONTROL));
    }

    #[tokio::test]
    async fn unconfigured_proxy_reports_service_unavailable() {
        let base_url = start_fake(true).await;
        let mut config = config_for(&base_url);
        config.api_key.clear();
        let app = app_from_config(config, false, test_config_path());

        let response = app
            .router
            .clone()
            .oneshot(app.device_request("/api/health"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"], NOT_CONFIGURED);
        assert_eq!(body["code"], "not_configured");

        let response = app
            .router
            .clone()
            .oneshot(app.device_request("/api/torrents"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["code"], "not_configured");
    }

    #[tokio::test]
    async fn streams_a_zip_with_the_torrent_files() {
        let app = app(true).await;
        let response = app
            .router
            .clone()
            .oneshot(app.admin_request(&format!("/archive/{HASH}")))
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
    async fn archive_tickets_are_single_use_and_bound_to_their_hash() {
        let app = app(true).await;

        let response = app
            .router
            .clone()
            .oneshot(app.device_json("POST", &format!("/api/archive/{HASH}/ticket"), json!({})))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["expiresIn"], 60);
        let ticket = body["ticket"].as_str().unwrap().to_string();

        let response = app
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/archive/{OTHER_HASH}?ticket={ticket}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let response = app
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/archive/{HASH}?ticket={ticket}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let replay = app
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/archive/{HASH}?ticket={ticket}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);

        let invalid = app
            .router
            .clone()
            .oneshot(app.device_json("POST", "/api/archive/not-a-hash/ticket", json!({})))
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn archive_endpoints_refuse_torrents_outside_the_filter() {
        let app = app(true).await;

        let response = app
            .router
            .clone()
            .oneshot(app.device_json(
                "POST",
                &format!("/api/archive/{OTHER_HASH}/ticket"),
                json!({}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"], "Torrent not found.");

        let response = app
            .router
            .clone()
            .oneshot(app.admin_request(&format!("/archive/{OTHER_HASH}")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"], "Torrent not found.");

        // Unknown hashes cannot mint a ticket or start a download either.
        let unknown = "4444444444444444444444444444444444444444";
        let response = app
            .router
            .clone()
            .oneshot(app.device_json("POST", &format!("/api/archive/{unknown}/ticket"), json!({})))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        let response = app
            .router
            .clone()
            .oneshot(app.admin_request(&format!("/archive/{unknown}")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn rejects_incomplete_torrents_and_bad_hashes() {
        let incomplete = app(false).await;
        let response = incomplete
            .router
            .clone()
            .oneshot(incomplete.admin_request(&format!("/archive/{HASH}")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);

        let complete = app(true).await;
        let response = complete
            .router
            .clone()
            .oneshot(complete.admin_request("/archive/not-a-hash"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn config_api_never_returns_secrets_and_includes_magnet_defaults() {
        let app = app(true).await;
        let response = app
            .router
            .clone()
            .oneshot(app.admin_request("/api/config"))
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
    async fn device_tokens_cannot_reach_admin_routes() {
        let app = app(true).await;

        let response = app
            .router
            .clone()
            .oneshot(app.device_request("/api/config"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"], "Admin sign-in is required for this action.");

        let response = app
            .router
            .clone()
            .oneshot(app.device_json(
                "PUT",
                "/api/config",
                json!({ "qbitBaseUrl": "http://127.0.0.1:1" }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn saving_credentials_activates_the_client() {
        let base_url = start_fake(true).await;
        let mut config = config_for(&base_url);
        config.api_key.clear();
        let app = app_from_config(config, false, test_config_path());

        let response = app
            .router
            .clone()
            .oneshot(app.admin_request("/api/health"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);

        let response = app
            .router
            .clone()
            .oneshot(app.admin_json(
                "PUT",
                "/api/config",
                json!({
                    "qbitBaseUrl": base_url,
                    "qbitApiKey": "qbt_test",
                    "defaultCategory": "remagnet",
                    "defaultTags": ["remagnet"],
                }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["hasApiKey"], true);

        let response = app
            .router
            .clone()
            .oneshot(app.admin_request("/api/health"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn lists_only_relevant_torrents() {
        let app = app(true).await;
        let response = app
            .router
            .clone()
            .oneshot(app.device_request("/api/torrents"))
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
        let app = app_with_filter(true, "", &[]).await;
        let response = app
            .router
            .clone()
            .oneshot(app.admin_request("/api/torrents"))
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
            .router
            .clone()
            .oneshot(app.device_request(&format!("/api/torrents/{OTHER_HASH}")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["hash"], OTHER_HASH);
        assert_eq!(body["category"], "films");

        let response = app
            .router
            .clone()
            .oneshot(app.device_request("/api/torrents/not-a-hash"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let response = app
            .router
            .clone()
            .oneshot(app.device_request("/api/torrents/2222222222222222222222222222222222222222"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn adding_a_torrent_uses_the_proxy_defaults() {
        let app = app_with_filter(true, "remagnet", &["remagnet", "nas"]).await;
        let magnet = format!("magnet:?xt=urn:btih:{HASH}&dn=Example");

        let response = app
            .router
            .clone()
            .oneshot(app.device_json(
                "POST",
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
        let app = app(true).await;
        let response = app
            .router
            .clone()
            .oneshot(app.admin_json("POST", "/api/torrents", json!({ "urls": [] })))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn deletes_only_relevant_torrents() {
        let app = app(true).await;

        let response = app
            .router
            .clone()
            .oneshot(app.admin_delete(&format!("/api/torrents/{OTHER_HASH}")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        let response = app
            .router
            .clone()
            .oneshot(app.admin_delete(&format!("/api/torrents/{HASH}?deleteFiles=true")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);

        let response = app
            .router
            .clone()
            .oneshot(app.admin_delete(&format!("/api/torrents/{HASH}?deleteFiles=maybe")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn pairing_needs_an_administrator_not_a_device_token() {
        let app = app(true).await;

        let response = app
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pair")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({ "url": "http://127.0.0.1:8080" }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let response = app
            .router
            .clone()
            .oneshot(app.device_json(
                "POST",
                "/api/pair",
                json!({ "url": "http://127.0.0.1:8080" }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        let response = app
            .router
            .clone()
            .oneshot(app.admin_json(
                "POST",
                "/api/pair",
                json!({ "url": "http://127.0.0.1:8080" }),
            ))
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
        let app = app(true).await;
        let response = app
            .router
            .clone()
            .oneshot(app.admin_json(
                "POST",
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

    async fn claim_pairing(app: &TestApp, device_name: &str) -> ClaimedPairing {
        use aes_gcm::{
            aead::{Aead, KeyInit},
            Aes256Gcm, Nonce,
        };
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

        let response = app
            .router
            .clone()
            .oneshot(app.admin_json(
                "POST",
                "/api/pair",
                json!({ "url": "http://127.0.0.1:8080" }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
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
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pair/claim")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({ "id": id, "proof": proof, "deviceName": device_name }).to_string(),
                    ))
                    .unwrap(),
            )
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
    async fn pairing_claim_mints_a_usable_device_token_once() {
        let app = app(true).await;
        let claimed = claim_pairing(&app, "Pixel 9").await;

        assert_eq!(claimed.payload["version"], 2);
        let token = claimed.payload["proxyToken"].as_str().unwrap();
        assert!(token.starts_with("rmg_"));
        assert_ne!(token, app.device_token);
        assert!(claimed.payload.get("qbitBaseUrl").is_none());
        assert!(claimed.payload.get("authMode").is_none());
        assert!(claimed.payload.get("apiKey").is_none());
        assert!(claimed.payload.get("username").is_none());
        assert!(claimed.payload.get("password").is_none());

        let device = app
            .state
            .auth
            .read()
            .await
            .devices
            .iter()
            .find(|device| device.name == "Pixel 9")
            .map(|device| device.id.clone());
        assert!(device.is_some());

        let response = app
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/health")
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let replay = app
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pair/claim")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({ "id": claimed.id, "proof": claimed.proof }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(replay.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn pairing_claim_never_requires_two_factor() {
        let app = app(true).await;
        {
            let mut data = app.state.auth.write().await;
            let admin = data.admin.as_mut().unwrap();
            admin.totp_secret = Some("JBSWY3DPEHPK3PXP".to_string());
            admin.totp_last_step = Some(1);
        }

        let claimed = claim_pairing(&app, "Paired phone").await;
        let token = claimed.payload["proxyToken"].as_str().unwrap();
        assert!(token.starts_with("rmg_"));

        let response = app
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/health")
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn revoked_devices_stop_working() {
        let app = app(true).await;
        let id = app
            .state
            .auth
            .read()
            .await
            .devices
            .first()
            .unwrap()
            .id
            .clone();

        let response = app
            .router
            .clone()
            .oneshot(app.admin_delete(&format!("/api/devices/{id}")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);

        let response = app
            .router
            .clone()
            .oneshot(app.device_request("/api/health"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn unknown_hashes_are_not_found() {
        // A syntactically valid hash that qBittorrent does not know.
        let app = app(true).await;
        let response = app
            .router
            .clone()
            .oneshot(app.device_request("/api/torrents/3333333333333333333333333333333333333333"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn delete_files_parsing_is_strict() {
        assert!(!parse_delete_files(&QueryMap::new()).unwrap());
        assert!(!parse_delete_files(&HashMap::from([(
            "deleteFiles".to_string(),
            "false".to_string()
        )]))
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
