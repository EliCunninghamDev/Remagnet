use std::{
    collections::HashMap,
    sync::{atomic::AtomicBool, Arc, Mutex},
};

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::json;
use tokio_util::io::ReaderStream;
use tower_http::trace::TraceLayer;

use crate::{
    auth::is_authorized,
    config::{save, ConfigUpdate, PublicConfig},
    error::AppError,
    qbit::QbitClient,
    zipstream::{
        content_disposition, torrent_completed, validate_hash, write_zip, zip_filename, ZipStream,
    },
    AppState,
};

type QueryMap = HashMap<String, String>;

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(ui))
        .route("/assets/departure-mono.woff2", get(wordmark_font))
        .route("/healthz", get(healthz))
        .route("/api/health", get(api_health))
        .route("/api/config", get(get_config).put(put_config))
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
    let qbit = state.qbit.read().await.clone();
    let (app_version, web_api_version) = qbit.test_connection().await?;
    Ok(Json(json!({
        "ok": true,
        "appVersion": app_version,
        "webApiVersion": web_api_version,
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

    // Build the client before touching the file so an invalid URL never
    // replaces a working configuration.
    let qbit = QbitClient::new(&candidate).map_err(AppError::internal)?;
    save(&state.config_path, &candidate)
        .await
        .map_err(AppError::internal)?;

    *state.config.write().await = candidate.clone();
    *state.qbit.write().await = qbit;

    Ok(Json(PublicConfig::from(&candidate)))
}

async fn archive(
    State(state): State<Arc<AppState>>,
    Path(hash): Path<String>,
    headers: HeaderMap,
    Query(query): Query<QueryMap>,
) -> Result<Response, AppError> {
    require_auth(&state, &headers, &query)?;
    validate_hash(&hash)?;

    let qbit = state.qbit.read().await.clone();
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

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Read};

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

    #[derive(Clone)]
    struct FakeQbit {
        completed: bool,
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

        let path = request.uri().path().to_string();
        match path.as_str() {
            "/api/v2/app/version" => "5.3.0".into_response(),
            "/api/v2/app/webapiVersion" => "2.16.2".into_response(),
            "/api/v2/torrents/info" => Json(json!([{
                "hash": HASH,
                "name": "Test Torrent",
                "progress": if state.completed { 1.0 } else { 0.5 },
                "amount_left": if state.completed { 0 } else { 512 },
                "state": "seeding",
            }]))
            .into_response(),
            "/api/v2/torrents/files" => Json(json!([
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
            "/api/v2/torrents/downloadFile" => {
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

    async fn app(completed: bool) -> Router {
        let base_url = start_fake(completed).await;
        let config = Config {
            qbit_base_url: base_url,
            qbit_api_key: "qbt_test".to_string(),
            qbit_username: String::new(),
            qbit_password: String::new(),
        };
        let qbit = QbitClient::new(&config).unwrap();
        let state = Arc::new(AppState {
            config_path: std::path::PathBuf::from("/tmp/remagnet-bridge-test-config.json"),
            config: RwLock::new(config),
            qbit: RwLock::new(qbit),
            token: TOKEN.to_string(),
        });
        router(state)
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
    async fn config_api_never_returns_secrets() {
        let response = app(true)
            .await
            .oneshot(request("/api/config"))
            .await
            .unwrap();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["hasApiKey"], true);
        assert!(body.get("qbitApiKey").is_none());
    }
}
