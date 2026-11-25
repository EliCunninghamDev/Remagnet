use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    routing::{delete, get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;

use crate::{
    auth::{self, AdminAccount, PublicDevice},
    error::AppError,
    pairing, totp, AppState,
};

/// Longest accepted administrator username.
const MAX_USERNAME_LEN: usize = 64;
/// Shortest accepted administrator password.
const MIN_PASSWORD_LEN: usize = 12;

/// Authenticate an administrator browser session.
///
/// A valid device token is recognised only to explain why it is not enough:
/// pairing a device must never grant access to the administrative surface.
pub async fn require_admin(state: &AppState, headers: &HeaderMap) -> Result<String, AppError> {
    let session_username = match auth::extract_session_cookie(headers) {
        Some(token) => state
            .sessions
            .lock()
            .map_err(|_| AppError::internal("session state is unavailable"))?
            .validate(token),
        None => None,
    };
    if let Some(username) = session_username {
        return Ok(username);
    }

    if let Some(token) = auth::extract_bearer_token(headers) {
        let known_device = state
            .auth
            .read()
            .await
            .find_device_by_token(token)
            .is_some();
        if known_device {
            return Err(AppError::Forbidden(
                "Admin sign-in is required for this action.".to_string(),
            ));
        }
    }

    Err(AppError::Unauthorized)
}

/// Accept either a valid device token or an administrator session.
pub async fn require_device_or_admin(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), AppError> {
    if let Some(token) = auth::extract_bearer_token(headers) {
        let now = auth::now_secs();
        let mut data = state.auth.write().await;
        if let Some(id) = data
            .find_device_by_token(token)
            .map(|device| device.id.clone())
        {
            if data.touch_device(&id, now) {
                auth::save(&state.auth_path, &data).map_err(AppError::internal)?;
            }
            return Ok(());
        }
    }

    if let Some(token) = auth::extract_session_cookie(headers) {
        let valid = state
            .sessions
            .lock()
            .map_err(|_| AppError::internal("session state is unavailable"))?
            .validate(token)
            .is_some();
        if valid {
            return Ok(());
        }
    }

    Err(AppError::Unauthorized)
}

/// Authenticate an archive download with a device token, an admin session, or
/// a single-use ticket bound to this torrent hash.
pub async fn require_archive_auth(
    state: &AppState,
    headers: &HeaderMap,
    query: &HashMap<String, String>,
    hash: &str,
) -> Result<(), AppError> {
    if require_device_or_admin(state, headers).await.is_ok() {
        return Ok(());
    }

    let Some(ticket) = query.get("ticket") else {
        return Err(AppError::Unauthorized);
    };
    let consumed = state
        .archive_tickets
        .lock()
        .map_err(|_| AppError::internal("archive ticket state is unavailable"))?
        .consume(ticket, hash);
    if consumed {
        Ok(())
    } else {
        Err(AppError::Unauthorized)
    }
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/auth/status", get(status))
        .route("/api/auth/setup", post(setup))
        .route("/api/auth/login", post(login))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/password", post(change_password))
        .route("/api/auth/2fa/setup", post(begin_totp_setup))
        .route("/api/auth/2fa/enable", post(enable_totp))
        .route("/api/auth/2fa/disable", post(disable_totp))
        .route("/api/auth/device", post(device_login))
        .route("/api/devices", get(list_devices))
        // Literal route must stay ahead of `/api/devices/{id}` so `current`
        // is never interpreted as a device id.
        .route("/api/devices/current", delete(revoke_current_device))
        .route("/api/devices/{id}", delete(delete_device))
}

fn secure_cookie(headers: &HeaderMap) -> bool {
    forwarded_proto(headers) == Some("https")
}

/// The scheme named by `X-Forwarded-Proto`, if it is `http` or `https`.
///
/// Proxies may append their own hop, so only the first value is considered.
pub(crate) fn forwarded_proto(headers: &HeaderMap) -> Option<&'static str> {
    let value = headers.get("x-forwarded-proto")?.to_str().ok()?;
    let scheme = value.split(',').next()?.trim();
    if scheme.eq_ignore_ascii_case("https") {
        Some("https")
    } else if scheme.eq_ignore_ascii_case("http") {
        Some("http")
    } else {
        None
    }
}

fn create_session(state: &AppState, username: &str) -> Result<String, AppError> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| AppError::internal("session state is unavailable"))?;
    Ok(sessions.create(username))
}

fn client_key(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            headers
                .get("x-real-ip")
                .and_then(|value| value.to_str().ok())
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .unwrap_or("global")
        .to_string()
}

fn record_failure(state: &AppState, key: &str) -> Result<(), AppError> {
    state
        .rate_limiter
        .lock()
        .map_err(|_| AppError::internal("sign-in throttling is unavailable"))?
        .record_failure(key);
    Ok(())
}

async fn authenticate_credentials(
    state: &AppState,
    headers: &HeaderMap,
    username: &str,
    password: &str,
    totp_code: Option<&str>,
) -> Result<(String, bool), AppError> {
    let key = client_key(headers);
    {
        let mut limiter = state
            .rate_limiter
            .lock()
            .map_err(|_| AppError::internal("sign-in throttling is unavailable"))?;
        if let Err(retry) = limiter.check(&key) {
            return Err(AppError::TooManyRequests {
                message: format!("Too many sign-in attempts. Try again in {retry} seconds."),
                retry_after: retry,
            });
        }
    }

    let credential = {
        let data = state.auth.read().await;
        data.admin
            .as_ref()
            .filter(|admin| admin.username == username)
            .filter(|admin| auth::verify_password(password, &admin.password_hash))
            .map(|admin| (admin.username.clone(), admin.totp_secret.is_some()))
    };

    let Some((username, totp_enabled)) = credential else {
        record_failure(state, &key)?;
        return Err(AppError::Unauthorized);
    };

    if totp_enabled {
        let code = totp_code.unwrap_or("").trim();
        if code.is_empty() {
            return Err(AppError::TotpRequired);
        }

        let verified = {
            let mut data = state.auth.write().await;
            let admin = data.admin.as_mut().ok_or(AppError::Unauthorized)?;
            let result = verify_second_factor(admin, code);
            if result.is_ok() {
                auth::save(&state.auth_path, &data).map_err(AppError::internal)?;
            }
            result.is_ok()
        };
        if !verified {
            record_failure(state, &key)?;
            return Err(AppError::Unauthorized);
        }
    }

    if let Ok(mut limiter) = state.rate_limiter.lock() {
        limiter.record_success(&key);
    }
    Ok((username, totp_enabled))
}

/// Verify a TOTP code, or consume a matching recovery code.
fn verify_second_factor(admin: &mut AdminAccount, code: &str) -> Result<(), AppError> {
    let secret = admin
        .totp_secret
        .clone()
        .ok_or_else(|| AppError::BadRequest("Two-factor authentication is not enabled.".into()))?;

    if let Some(step) = totp::verify_code(&secret, code, auth::now_secs(), admin.totp_last_step) {
        admin.totp_last_step = Some(step);
        return Ok(());
    }

    let hashed = totp::hash_recovery_code(code);
    let mut matched = None;
    for (index, stored) in admin.recovery_code_hashes.iter().enumerate() {
        if auth::ct_eq_str(stored, &hashed) {
            matched = Some(index);
        }
    }
    match matched {
        Some(index) => {
            admin.recovery_code_hashes.remove(index);
            Ok(())
        }
        None => Err(AppError::Unauthorized),
    }
}

async fn status(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Json<serde_json::Value> {
    let (initialized, username, totp_enabled) = {
        let data = state.auth.read().await;
        let admin = data.admin.as_ref();
        (
            admin.is_some(),
            admin.map(|admin| admin.username.clone()),
            admin.is_some_and(|admin| admin.totp_secret.is_some()),
        )
    };

    let authenticated = match (auth::extract_session_cookie(&headers), username.as_deref()) {
        (Some(token), Some(username)) => state
            .sessions
            .lock()
            .ok()
            .and_then(|mut sessions| sessions.validate(token))
            .is_some_and(|session_user| session_user == username),
        _ => false,
    };

    Json(json!({
        "initialized": initialized,
        "requiresSetupCode": state.setup_code.is_some(),
        "authenticated": authenticated,
        "username": username,
        "totpEnabled": totp_enabled,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupRequest {
    username: String,
    password: String,
    #[serde(default)]
    setup_code: Option<String>,
}

fn setup_code_matches(expected: &str, provided: Option<&str>) -> bool {
    let Some(provided) = provided else {
        return false;
    };
    let provided = provided.trim();
    auth::ct_eq_str(expected, provided)
}

async fn setup(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<SetupRequest>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    {
        let data = state.auth.read().await;
        if data.admin.is_some() {
            return Err(AppError::Conflict(
                "The proxy is already set up. Sign in instead.".to_string(),
            ));
        }
    }

    if let Some(expected) = state.setup_code.as_deref() {
        if !setup_code_matches(expected, request.setup_code.as_deref()) {
            return Err(AppError::Forbidden(
                "The setup code is incorrect.".to_string(),
            ));
        }
    }

    let username = request.username.trim().to_string();
    if username.is_empty() || username.chars().count() > MAX_USERNAME_LEN {
        return Err(AppError::BadRequest(format!(
            "The username must be between 1 and {MAX_USERNAME_LEN} characters."
        )));
    }
    if request.password.chars().count() < MIN_PASSWORD_LEN {
        return Err(AppError::BadRequest(format!(
            "The password must be at least {MIN_PASSWORD_LEN} characters."
        )));
    }

    let password_hash = auth::hash_password(&request.password).map_err(AppError::internal)?;

    {
        let mut data = state.auth.write().await;
        if data.admin.is_some() {
            return Err(AppError::Conflict(
                "The proxy is already set up. Sign in instead.".to_string(),
            ));
        }
        data.admin = Some(AdminAccount {
            username: username.clone(),
            password_hash,
            totp_secret: None,
            totp_last_step: None,
            recovery_code_hashes: Vec::new(),
        });
        auth::save(&state.auth_path, &data).map_err(AppError::internal)?;
    }

    let token = create_session(&state, &username)?;
    let cookie = auth::session_cookie_header(&token, secure_cookie(&headers));

    Ok((
        StatusCode::CREATED,
        [
            (header::SET_COOKIE, cookie),
            (header::CACHE_CONTROL, "no-store".to_string()),
        ],
        Json(json!({ "username": username, "totpEnabled": false })),
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginRequest {
    username: String,
    password: String,
    #[serde(default)]
    totp_code: Option<String>,
}

async fn login(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<LoginRequest>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    let (username, totp_enabled) = authenticate_credentials(
        &state,
        &headers,
        &request.username,
        &request.password,
        request.totp_code.as_deref(),
    )
    .await?;

    let token = create_session(&state, &username)?;
    let cookie = auth::session_cookie_header(&token, secure_cookie(&headers));

    Ok((
        [
            (header::SET_COOKIE, cookie),
            (header::CACHE_CONTROL, "no-store".to_string()),
        ],
        Json(json!({ "username": username, "totpEnabled": totp_enabled })),
    ))
}

async fn logout(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<impl axum::response::IntoResponse, AppError> {
    require_admin(&state, &headers).await?;

    if let Some(token) = auth::extract_session_cookie(&headers) {
        if let Ok(mut sessions) = state.sessions.lock() {
            sessions.revoke(token);
        }
    }

    let cookie = auth::clear_session_cookie_header(secure_cookie(&headers));
    Ok(([(header::SET_COOKIE, cookie)], StatusCode::NO_CONTENT))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasswordRequest {
    current_password: String,
    new_password: String,
}

async fn change_password(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<PasswordRequest>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    let username = require_admin(&state, &headers).await?;

    if request.new_password.chars().count() < MIN_PASSWORD_LEN {
        return Err(AppError::BadRequest(format!(
            "The new password must be at least {MIN_PASSWORD_LEN} characters."
        )));
    }
    let password_hash = auth::hash_password(&request.new_password).map_err(AppError::internal)?;

    {
        let mut data = state.auth.write().await;
        let admin = data.admin.as_mut().ok_or(AppError::Unauthorized)?;
        if !auth::verify_password(&request.current_password, &admin.password_hash) {
            return Err(AppError::Forbidden(
                "The current password is incorrect.".to_string(),
            ));
        }
        admin.password_hash = password_hash;
        auth::save(&state.auth_path, &data).map_err(AppError::internal)?;
    }

    {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| AppError::internal("session state is unavailable"))?;
        sessions.revoke_all();
    }

    let token = create_session(&state, &username)?;
    let cookie = auth::session_cookie_header(&token, secure_cookie(&headers));

    Ok(([(header::SET_COOKIE, cookie)], StatusCode::NO_CONTENT))
}

async fn begin_totp_setup(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<impl axum::response::IntoResponse, AppError> {
    let username = require_admin(&state, &headers).await?;

    let secret = totp::generate_secret().map_err(AppError::internal)?;
    let otpauth_uri = totp::otpauth_uri(&username, &secret);
    let svg = pairing::qr_svg(&otpauth_uri).map_err(AppError::internal)?;

    state
        .pending_totp
        .lock()
        .map_err(|_| AppError::internal("two-factor state is unavailable"))?
        .begin(secret.clone());

    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({
            "secret": secret,
            "otpauthUri": otpauth_uri,
            "svg": svg,
        })),
    ))
}

#[derive(Debug, Deserialize)]
struct CodeRequest {
    code: String,
}

async fn enable_totp(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<CodeRequest>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    let username = require_admin(&state, &headers).await?;

    let pending = state
        .pending_totp
        .lock()
        .map_err(|_| AppError::internal("two-factor state is unavailable"))?
        .peek()
        .map(str::to_string)
        .ok_or_else(|| {
            AppError::BadRequest("Start two-factor setup before enabling it.".to_string())
        })?;

    let step =
        totp::verify_code(&pending, &request.code, auth::now_secs(), None).ok_or_else(|| {
            AppError::BadRequest(
                "That code is not valid. Check your authenticator and try again.".to_string(),
            )
        })?;

    let recovery_codes = totp::generate_recovery_codes().map_err(AppError::internal)?;
    let hashes = recovery_codes
        .iter()
        .map(|code| totp::hash_recovery_code(code))
        .collect();

    {
        let mut data = state.auth.write().await;
        let admin = data.admin.as_mut().ok_or(AppError::Unauthorized)?;
        if admin.username != username {
            return Err(AppError::Unauthorized);
        }
        admin.totp_secret = Some(pending);
        admin.totp_last_step = Some(step);
        admin.recovery_code_hashes = hashes;
        auth::save(&state.auth_path, &data).map_err(AppError::internal)?;
    }

    if let Ok(mut pending) = state.pending_totp.lock() {
        pending.take();
    }

    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({ "recoveryCodes": recovery_codes })),
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DisableTotpRequest {
    password: String,
    #[serde(default)]
    code: Option<String>,
}

async fn disable_totp(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<DisableTotpRequest>,
) -> Result<StatusCode, AppError> {
    require_admin(&state, &headers).await?;

    let mut data = state.auth.write().await;
    let admin = data.admin.as_mut().ok_or(AppError::Unauthorized)?;
    if !auth::verify_password(&request.password, &admin.password_hash) {
        return Err(AppError::Forbidden(
            "The password is incorrect.".to_string(),
        ));
    }

    if admin.totp_secret.is_some() {
        let code = request.code.as_deref().unwrap_or("").trim();
        if code.is_empty() {
            return Err(AppError::BadRequest(
                "Enter a two-factor or recovery code.".to_string(),
            ));
        }
        if verify_second_factor(admin, code).is_err() {
            return Err(AppError::Unauthorized);
        }
    }

    admin.totp_secret = None;
    admin.totp_last_step = None;
    admin.recovery_code_hashes.clear();
    auth::save(&state.auth_path, &data).map_err(AppError::internal)?;

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceLoginRequest {
    username: String,
    password: String,
    #[serde(default)]
    totp_code: Option<String>,
    #[serde(default)]
    device_name: Option<String>,
}

async fn device_login(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<DeviceLoginRequest>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    let _ = authenticate_credentials(
        &state,
        &headers,
        &request.username,
        &request.password,
        request.totp_code.as_deref(),
    )
    .await?;

    let (token, record) =
        auth::mint_device(request.device_name.as_deref()).map_err(AppError::internal)?;
    let device = PublicDevice::from(&record);

    {
        let mut data = state.auth.write().await;
        data.devices.push(record);
        auth::save(&state.auth_path, &data).map_err(AppError::internal)?;
    }

    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({ "token": token, "device": device })),
    ))
}

async fn list_devices(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    require_admin(&state, &headers).await?;
    let data = state.auth.read().await;
    Ok(Json(json!({ "devices": data.public_devices() })))
}

async fn revoke_current_device(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<StatusCode, AppError> {
    // Administrative sessions are deliberately not enough here: this endpoint
    // revokes the caller's own device token, not an arbitrary device by id.
    let token = auth::extract_bearer_token(&headers).ok_or(AppError::Unauthorized)?;

    let removed = {
        let mut data = state.auth.write().await;
        let id = data
            .find_device_by_token(token)
            .map(|device| device.id.clone())
            .ok_or(AppError::Unauthorized)?;
        let removed = data.revoke_device(&id);
        if removed {
            auth::save(&state.auth_path, &data).map_err(AppError::internal)?;
        }
        removed
    };

    if removed {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::Unauthorized)
    }
}

async fn delete_device(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<StatusCode, AppError> {
    require_admin(&state, &headers).await?;

    let removed = {
        let mut data = state.auth.write().await;
        let removed = data.revoke_device(&id);
        if removed {
            auth::save(&state.auth_path, &data).map_err(AppError::internal)?;
        }
        removed
    };

    if removed {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::NotFound("Device not found.".to_string()))
    }
}

#[cfg(test)]
mod tests {
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        sync::Mutex,
    };

    use axum::{
        body::Body,
        http::{Request, StatusCode},
        Router,
    };
    use http_body_util::BodyExt;
    use tokio::sync::RwLock;
    use tower::ServiceExt;

    use super::*;
    use crate::{
        auth::{self, AuthData},
        config::Config,
        pairing::PairingStore,
    };

    const PASSWORD: &str = "correct horse battery staple";
    const USERNAME: &str = "admin";

    static NEXT_DIR: AtomicU64 = AtomicU64::new(0);

    struct TestApp {
        state: Arc<AppState>,
        router: Router,
        directory: PathBuf,
    }

    impl Drop for TestApp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }

    fn test_directory() -> PathBuf {
        std::env::temp_dir().join(format!(
            "remagnet-auth-test-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn state(directory: &std::path::Path, setup_code: Option<String>) -> Arc<AppState> {
        let config_path = directory.join("config.json");
        let auth_path = directory.join("auth.json");
        let config = Config {
            client_kind: crate::backend::ClientKind::Qbittorrent,
            base_url: "http://127.0.0.1:1".to_string(),
            api_key: "qbt_test".to_string(),
            username: String::new(),
            password: String::new(),
            downloads_dir: String::new(),
            client_downloads_dir: String::new(),
            default_category: "remagnet".to_string(),
            default_tags: vec!["remagnet".to_string()],
        };
        Arc::new(AppState {
            config_path,
            config: RwLock::new(config),
            env_overrides: crate::config::EnvOverrides::default(),
            backend: RwLock::new(None),
            auth_path,
            auth: RwLock::new(AuthData::default()),
            setup_code,
            sessions: Mutex::new(auth::SessionStore::default()),
            pending_totp: Mutex::new(auth::PendingTotpStore::default()),
            archive_tickets: Mutex::new(auth::ArchiveTicketStore::default()),
            rate_limiter: Mutex::new(auth::LoginRateLimiter::default()),
            pairings: Mutex::new(PairingStore::default()),
        })
    }

    fn app(setup_code: Option<&str>) -> TestApp {
        let directory = test_directory();
        std::fs::create_dir_all(&directory).unwrap();
        let state = state(&directory, setup_code.map(str::to_string));
        let router = router().with_state(Arc::clone(&state));
        TestApp {
            state,
            router,
            directory,
        }
    }

    async fn initialized_app() -> TestApp {
        let test = app(None);
        let response = request(
            &test.router,
            "POST",
            "/api/auth/setup",
            Some(json!({ "username": USERNAME, "password": PASSWORD })),
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::CREATED);
        test
    }

    async fn request(
        router: &Router,
        method: &str,
        uri: &str,
        body: Option<serde_json::Value>,
        cookie: Option<&str>,
    ) -> axum::response::Response {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(body) = body {
            builder = builder
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::CONTENT_LENGTH, body.to_string().len());
            let mut request = builder.body(Body::from(body.to_string())).unwrap();
            if let Some(cookie) = cookie {
                request.headers_mut().insert(
                    header::COOKIE,
                    format!("remagnet_session={cookie}").parse().unwrap(),
                );
            }
            router.clone().oneshot(request).await.unwrap()
        } else {
            let mut request = builder.body(Body::empty()).unwrap();
            if let Some(cookie) = cookie {
                request.headers_mut().insert(
                    header::COOKIE,
                    format!("remagnet_session={cookie}").parse().unwrap(),
                );
            }
            router.clone().oneshot(request).await.unwrap()
        }
    }

    async fn body(response: axum::response::Response) -> serde_json::Value {
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn session_cookie(response: &axum::response::Response) -> String {
        response
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .trim_start_matches("remagnet_session=")
            .to_string()
    }

    async fn login(app: &TestApp) -> String {
        let response = request(
            &app.router,
            "POST",
            "/api/auth/login",
            Some(json!({ "username": USERNAME, "password": PASSWORD })),
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        session_cookie(&response)
    }

    fn hotp_for_test(secret: &str, step: u64) -> u32 {
        use hmac::{Hmac, Mac};
        use sha1::Sha1;

        let secret = totp::base32_decode(secret).unwrap();
        let mut mac = Hmac::<Sha1>::new_from_slice(&secret).unwrap();
        mac.update(&step.to_be_bytes());
        let digest = mac.finalize().into_bytes();
        let offset = usize::from(digest[19] & 0x0F);
        let binary = (u32::from(digest[offset] & 0x7F) << 24)
            | (u32::from(digest[offset + 1]) << 16)
            | (u32::from(digest[offset + 2]) << 8)
            | u32::from(digest[offset + 3]);
        binary % 1_000_000
    }

    fn totp_code(secret: &str) -> String {
        format!(
            "{:06}",
            hotp_for_test(secret, auth::now_secs() / totp::TOTP_PERIOD)
        )
    }

    #[tokio::test]
    async fn status_reports_setup_requirements() {
        let test = app(None);
        let response = request(&test.router, "GET", "/api/auth/status", None, None).await;
        assert_eq!(response.status(), StatusCode::OK);
        let value = body(response).await;
        assert_eq!(value["initialized"], false);
        assert_eq!(value["requiresSetupCode"], false);
        assert_eq!(value["authenticated"], false);
        assert!(value["username"].is_null());

        let test = app(Some("let-me-in"));
        let response = request(&test.router, "GET", "/api/auth/status", None, None).await;
        assert_eq!(body(response).await["requiresSetupCode"], true);
    }

    #[tokio::test]
    async fn setup_requires_a_matching_setup_code_and_valid_fields() {
        let test = app(Some("let-me-in"));

        let response = request(
            &test.router,
            "POST",
            "/api/auth/setup",
            Some(json!({ "username": USERNAME, "password": PASSWORD })),
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        let response = request(
            &test.router,
            "POST",
            "/api/auth/setup",
            Some(json!({
                "username": USERNAME,
                "password": "short",
                "setupCode": "let-me-in",
            })),
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let response = request(
            &test.router,
            "POST",
            "/api/auth/setup",
            Some(json!({
                "username": USERNAME,
                "password": PASSWORD,
                "setupCode": "let-me-in",
            })),
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::CREATED);
        let cookie = session_cookie(&response);
        assert!(!cookie.is_empty());
        let value = body(response).await;
        assert_eq!(value["username"], USERNAME);
        assert_eq!(value["totpEnabled"], false);

        let duplicate = request(
            &test.router,
            "POST",
            "/api/auth/setup",
            Some(json!({
                "username": "someone",
                "password": PASSWORD,
                "setupCode": "let-me-in",
            })),
            None,
        )
        .await;
        assert_eq!(duplicate.status(), StatusCode::CONFLICT);

        assert!(test.state.auth_path.exists());
    }

    #[tokio::test]
    async fn login_rejects_bad_passwords_and_throttles_repeated_failures() {
        let test = initialized_app().await;

        let response = request(
            &test.router,
            "POST",
            "/api/auth/login",
            Some(json!({ "username": USERNAME, "password": "wrong password" })),
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        for _ in 0..auth::LOGIN_MAX_FAILURES {
            let _ = request(
                &test.router,
                "POST",
                "/api/auth/login",
                Some(json!({ "username": USERNAME, "password": "wrong password" })),
                None,
            )
            .await;
        }

        let response = request(
            &test.router,
            "POST",
            "/api/auth/login",
            Some(json!({ "username": USERNAME, "password": PASSWORD })),
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        let retry_after: u64 = response
            .headers()
            .get(header::RETRY_AFTER)
            .expect("429 must include Retry-After")
            .to_str()
            .unwrap()
            .parse()
            .unwrap();
        assert!(retry_after > 0 && retry_after <= auth::LOGIN_WINDOW.as_secs());
        let body = body(response).await;
        assert_eq!(body["code"], "rate_limited");
        assert_eq!(
            body["error"],
            format!("Too many sign-in attempts. Try again in {retry_after} seconds.")
        );

        // A different client is not affected by another address's failures.
        let response = Request::builder()
            .method("POST")
            .uri("/api/auth/login")
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-forwarded-for", "198.51.100.9")
            .body(Body::from(
                json!({ "username": USERNAME, "password": PASSWORD }).to_string(),
            ))
            .unwrap();
        let response = test.router.clone().oneshot(response).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn totp_setup_enable_login_replay_recovery_and_disable() {
        let test = initialized_app().await;
        let cookie = login(&test).await;

        let response = request(
            &test.router,
            "POST",
            "/api/auth/2fa/setup",
            None,
            Some(&cookie),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let setup = body(response).await;
        let secret = setup["secret"].as_str().unwrap().to_string();
        assert!(setup["otpauthUri"]
            .as_str()
            .unwrap()
            .starts_with("otpauth://totp/"));
        assert!(setup["svg"].as_str().unwrap().starts_with("<svg"));

        let code = totp_code(&secret);
        let response = request(
            &test.router,
            "POST",
            "/api/auth/2fa/enable",
            Some(json!({ "code": code })),
            Some(&cookie),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let enabled = body(response).await;
        let recovery_codes = enabled["recoveryCodes"].as_array().unwrap();
        assert_eq!(recovery_codes.len(), 8);
        let recovery = recovery_codes[0].as_str().unwrap().to_string();
        let disable_recovery = recovery_codes[1].as_str().unwrap().to_string();

        // Enrolment consumed the current step; rewind it so this test can use
        // the current code once and then prove that a replay is rejected.
        {
            let mut data = test.state.auth.write().await;
            data.admin.as_mut().unwrap().totp_last_step =
                Some(auth::now_secs() / totp::TOTP_PERIOD - 1);
        }

        let missing = request(
            &test.router,
            "POST",
            "/api/auth/login",
            Some(json!({ "username": USERNAME, "password": PASSWORD })),
            None,
        )
        .await;
        assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(body(missing).await["code"], "totp_required");

        // The same TOTP step cannot be replayed.
        let code = totp_code(&secret);
        let first = request(
            &test.router,
            "POST",
            "/api/auth/login",
            Some(json!({ "username": USERNAME, "password": PASSWORD, "totpCode": code })),
            None,
        )
        .await;
        assert_eq!(first.status(), StatusCode::OK);
        let cookie = session_cookie(&first);

        let replay = request(
            &test.router,
            "POST",
            "/api/auth/login",
            Some(json!({ "username": USERNAME, "password": PASSWORD, "totpCode": code })),
            None,
        )
        .await;
        assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);

        let recovery_login = request(
            &test.router,
            "POST",
            "/api/auth/login",
            Some(json!({ "username": USERNAME, "password": PASSWORD, "totpCode": recovery })),
            None,
        )
        .await;
        assert_eq!(recovery_login.status(), StatusCode::OK);

        // The recovery code is single use.
        let reused = request(
            &test.router,
            "POST",
            "/api/auth/login",
            Some(json!({ "username": USERNAME, "password": PASSWORD, "totpCode": recovery })),
            None,
        )
        .await;
        assert_eq!(reused.status(), StatusCode::UNAUTHORIZED);

        let disable = request(
            &test.router,
            "POST",
            "/api/auth/2fa/disable",
            Some(json!({ "password": PASSWORD })),
            Some(&cookie),
        )
        .await;
        assert_eq!(disable.status(), StatusCode::BAD_REQUEST);

        let disable = request(
            &test.router,
            "POST",
            "/api/auth/2fa/disable",
            Some(json!({ "password": PASSWORD, "code": disable_recovery })),
            Some(&cookie),
        )
        .await;
        assert_eq!(disable.status(), StatusCode::NO_CONTENT);
        assert!(test
            .state
            .auth
            .read()
            .await
            .admin
            .as_ref()
            .unwrap()
            .totp_secret
            .is_none());
    }

    #[tokio::test]
    async fn direct_device_login_mints_a_token_that_is_scoped_away_from_admin_routes() {
        let test = initialized_app().await;

        let response = request(
            &test.router,
            "POST",
            "/api/auth/device",
            Some(json!({
                "username": USERNAME,
                "password": PASSWORD,
                "deviceName": "Pixel 9",
            })),
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let value = body(response).await;
        let token = value["token"].as_str().unwrap().to_string();
        assert!(token.starts_with("rmg_"));
        assert_eq!(value["device"]["name"], "Pixel 9");

        let response = Request::builder()
            .method("GET")
            .uri("/api/devices")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        let response = test.router.clone().oneshot(response).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            body(response).await["error"],
            "Admin sign-in is required for this action."
        );
    }

    #[tokio::test]
    async fn devices_can_be_listed_and_revoked_by_an_administrator() {
        let test = initialized_app().await;
        let cookie = login(&test).await;

        let response = request(
            &test.router,
            "POST",
            "/api/auth/device",
            Some(json!({
                "username": USERNAME,
                "password": PASSWORD,
                "deviceName": "Tablet",
            })),
            None,
        )
        .await;
        let token = body(response).await["token"].as_str().unwrap().to_string();

        let devices = request(&test.router, "GET", "/api/devices", None, Some(&cookie)).await;
        assert_eq!(devices.status(), StatusCode::OK);
        let devices = body(devices).await;
        let id = devices["devices"][0]["id"].as_str().unwrap().to_string();
        assert_eq!(devices["devices"][0]["name"], "Tablet");

        let revoke = request(
            &test.router,
            "DELETE",
            &format!("/api/devices/{id}"),
            None,
            Some(&cookie),
        )
        .await;
        assert_eq!(revoke.status(), StatusCode::NO_CONTENT);

        let missing = request(
            &test.router,
            "DELETE",
            &format!("/api/devices/{id}"),
            None,
            Some(&cookie),
        )
        .await;
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);

        let response = Request::builder()
            .method("GET")
            .uri("/api/devices")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        let response = test.router.clone().oneshot(response).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn devices_can_revoke_their_own_token() {
        let test = initialized_app().await;
        let cookie = login(&test).await;

        let response = request(
            &test.router,
            "POST",
            "/api/auth/device",
            Some(json!({
                "username": USERNAME,
                "password": PASSWORD,
                "deviceName": "Self revoking phone",
            })),
            None,
        )
        .await;
        let token = body(response).await["token"].as_str().unwrap().to_string();

        // An administrator session is not a device token: this endpoint only
        // revokes the calling device.
        let response = request(
            &test.router,
            "DELETE",
            "/api/devices/current",
            None,
            Some(&cookie),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let response = Request::builder()
            .method("DELETE")
            .uri("/api/devices/current")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        let response = test.router.clone().oneshot(response).await.unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);

        let saved = auth::load(&test.state.auth_path).unwrap();
        assert!(saved.devices.is_empty());

        // The revoked token no longer authenticates anything.
        let response = Request::builder()
            .method("GET")
            .uri("/api/devices")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        let response = test.router.clone().oneshot(response).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let response = Request::builder()
            .method("DELETE")
            .uri("/api/devices/current")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        let response = test.router.clone().oneshot(response).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn password_change_revokes_old_sessions() {
        let test = initialized_app().await;
        let cookie = login(&test).await;

        let response = request(
            &test.router,
            "POST",
            "/api/auth/password",
            Some(json!({
                "currentPassword": PASSWORD,
                "newPassword": "a much better password",
            })),
            Some(&cookie),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let fresh = session_cookie(&response);

        let old = request(&test.router, "GET", "/api/devices", None, Some(&cookie)).await;
        assert_eq!(old.status(), StatusCode::UNAUTHORIZED);

        let new = request(&test.router, "GET", "/api/devices", None, Some(&fresh)).await;
        assert_eq!(new.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn logout_revokes_the_session() {
        let test = initialized_app().await;
        let cookie = login(&test).await;

        let response = request(
            &test.router,
            "POST",
            "/api/auth/logout",
            None,
            Some(&cookie),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert!(response.headers().contains_key(header::SET_COOKIE));

        let response = request(&test.router, "GET", "/api/devices", None, Some(&cookie)).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}
