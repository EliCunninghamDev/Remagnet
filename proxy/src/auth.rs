use std::{
    collections::HashMap,
    path::Path,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Context, Result};
use argon2::{password_hash::SaltString, Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use axum::http::{header, HeaderMap};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// The browser session cookie name.
pub const SESSION_COOKIE: &str = "remagnet_session";

/// Browser sessions live for a week and are held in memory only.
pub const SESSION_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const MAX_SESSIONS: usize = 64;

/// A pending TOTP enrolment secret expires after ten minutes.
pub const PENDING_TOTP_TTL: Duration = Duration::from_secs(10 * 60);

/// Archive download tickets are single-use and short lived.
pub const ARCHIVE_TICKET_TTL: Duration = Duration::from_secs(60);
const MAX_ARCHIVE_TICKETS: usize = 128;

/// Login throttling: five failures inside a five-minute window.
pub const LOGIN_MAX_FAILURES: u32 = 5;
pub const LOGIN_WINDOW: Duration = Duration::from_secs(5 * 60);

const DEVICE_NAME_LIMIT: usize = 80;
const DEVICE_TOKEN_PREFIX: &str = "rmg_";
/// Persist device activity at most once per minute.
const DEVICE_TOUCH_INTERVAL_SECS: u64 = 60;

/// Everything persisted in `DATA_DIR/auth.json`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthData {
    #[serde(default)]
    pub admin: Option<AdminAccount>,
    #[serde(default)]
    pub devices: Vec<DeviceRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminAccount {
    pub username: String,
    /// Argon2id PHC string; never the raw password.
    pub password_hash: String,
    #[serde(default)]
    pub totp_secret: Option<String>,
    #[serde(default)]
    pub totp_last_step: Option<u64>,
    #[serde(default)]
    pub recovery_code_hashes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRecord {
    pub id: String,
    pub name: String,
    /// SHA-256 hex of the raw device token. The token itself is not stored.
    pub token_hash: String,
    pub created_at: u64,
    #[serde(default)]
    pub last_used_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicDevice {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub last_used_at: Option<u64>,
}

impl From<&DeviceRecord> for PublicDevice {
    fn from(device: &DeviceRecord) -> Self {
        Self {
            id: device.id.clone(),
            name: device.name.clone(),
            created_at: device.created_at,
            last_used_at: device.last_used_at,
        }
    }
}

impl AuthData {
    pub fn public_devices(&self) -> Vec<PublicDevice> {
        self.devices.iter().map(PublicDevice::from).collect()
    }

    /// Find a device by raw token, comparing every stored hash.
    pub fn find_device_by_token(&self, token: &str) -> Option<&DeviceRecord> {
        if token.is_empty() {
            return None;
        }

        let candidate = sha256_hex(token);
        let mut found = None;
        for device in &self.devices {
            if ct_eq_str(&device.token_hash, &candidate) && found.is_none() {
                found = Some(device);
            }
        }
        found
    }

    /// Record device activity, at most once per minute.
    pub fn touch_device(&mut self, id: &str, now: u64) -> bool {
        let Some(device) = self.devices.iter_mut().find(|device| device.id == id) else {
            return false;
        };
        let stale = device
            .last_used_at
            .is_none_or(|last_used| now.saturating_sub(last_used) > DEVICE_TOUCH_INTERVAL_SECS);
        if stale {
            device.last_used_at = Some(now);
        }
        stale
    }

    pub fn revoke_device(&mut self, id: &str) -> bool {
        let before = self.devices.len();
        self.devices.retain(|device| device.id != id);
        self.devices.len() != before
    }
}

/// Hash a password with Argon2id and a fresh sixteen-byte salt.
pub fn hash_password(password: &str) -> Result<String> {
    let mut salt = [0u8; 16];
    getrandom::getrandom(&mut salt)
        .map_err(|error| anyhow!("could not read randomness: {error}"))?;
    let salt = SaltString::encode_b64(&salt)
        .map_err(|error| anyhow!("could not encode the password salt: {error}"))?;

    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|error| anyhow!("could not hash the password: {error}"))
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

/// Mint a scoped device token and the record that authenticates it.
pub fn mint_device(name: Option<&str>) -> Result<(String, DeviceRecord)> {
    let mut token_bytes = [0u8; 32];
    let mut id_bytes = [0u8; 16];
    getrandom::getrandom(&mut token_bytes)
        .map_err(|error| anyhow!("could not read randomness: {error}"))?;
    getrandom::getrandom(&mut id_bytes)
        .map_err(|error| anyhow!("could not read randomness: {error}"))?;

    let token = format!(
        "{DEVICE_TOKEN_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(token_bytes)
    );
    let record = DeviceRecord {
        id: URL_SAFE_NO_PAD.encode(id_bytes),
        name: normalize_device_name(name),
        token_hash: sha256_hex(&token),
        created_at: now_secs(),
        last_used_at: None,
    };

    Ok((token, record))
}

fn normalize_device_name(name: Option<&str>) -> String {
    let name: String = name
        .unwrap_or_default()
        .trim()
        .chars()
        .take(DEVICE_NAME_LIMIT)
        .collect();
    if name.is_empty() {
        "Device".to_string()
    } else {
        name
    }
}

pub fn sha256_hex(input: &str) -> String {
    crate::backend::to_hex(&Sha256::digest(input.as_bytes()))
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// In-memory browser sessions keyed by random cookie token.
#[derive(Default)]
pub struct SessionStore {
    sessions: HashMap<String, Session>,
}

struct Session {
    username: String,
    expires_at: Instant,
}

impl SessionStore {
    pub fn create(&mut self, username: &str) -> String {
        let now = Instant::now();
        self.prune(now);

        if self.sessions.len() >= MAX_SESSIONS {
            if let Some(oldest) = self
                .sessions
                .iter()
                .min_by_key(|(_, session)| session.expires_at)
                .map(|(token, _)| token.clone())
            {
                self.sessions.remove(&oldest);
            }
        }

        let token = random_token();
        self.sessions.insert(
            token.clone(),
            Session {
                username: username.to_string(),
                expires_at: now + SESSION_TTL,
            },
        );
        token
    }

    pub fn validate(&mut self, token: &str) -> Option<String> {
        self.prune(Instant::now());
        self.sessions
            .get(token)
            .map(|session| session.username.clone())
    }

    pub fn revoke(&mut self, token: &str) {
        self.sessions.remove(token);
    }

    pub fn revoke_all(&mut self) {
        self.sessions.clear();
    }

    fn prune(&mut self, now: Instant) {
        self.sessions.retain(|_, session| session.expires_at > now);
    }
}

/// A pending TOTP enrolment secret for the admin setup handshake.
#[derive(Default)]
pub struct PendingTotpStore {
    pending: Option<PendingTotp>,
}

struct PendingTotp {
    secret: String,
    expires_at: Instant,
}

impl PendingTotpStore {
    pub fn begin(&mut self, secret: String) {
        self.pending = Some(PendingTotp {
            secret,
            expires_at: Instant::now() + PENDING_TOTP_TTL,
        });
    }

    pub fn peek(&mut self) -> Option<&str> {
        self.prune();
        self.pending.as_ref().map(|pending| pending.secret.as_str())
    }

    pub fn take(&mut self) -> Option<String> {
        self.prune();
        self.pending.take().map(|pending| pending.secret)
    }

    pub fn clear(&mut self) {
        self.pending = None;
    }

    fn prune(&mut self) {
        if self
            .pending
            .as_ref()
            .is_some_and(|pending| pending.expires_at <= Instant::now())
        {
            self.pending = None;
        }
    }
}

/// Single-use tickets that authorize an archive download without a token in
/// the URL. The ticket is bound to the torrent hash it was minted for.
#[derive(Default)]
pub struct ArchiveTicketStore {
    tickets: HashMap<String, ArchiveTicket>,
}

struct ArchiveTicket {
    hash: String,
    expires_at: Instant,
}

impl ArchiveTicketStore {
    pub fn create(&mut self, hash: &str) -> Result<(String, u64)> {
        let now = Instant::now();
        self.prune(now);

        if self.tickets.len() >= MAX_ARCHIVE_TICKETS {
            if let Some(oldest) = self
                .tickets
                .iter()
                .min_by_key(|(_, ticket)| ticket.expires_at)
                .map(|(ticket, _)| ticket.clone())
            {
                self.tickets.remove(&oldest);
            }
        }

        let mut bytes = [0u8; 16];
        getrandom::getrandom(&mut bytes)
            .map_err(|error| anyhow!("could not read randomness: {error}"))?;
        let ticket = URL_SAFE_NO_PAD.encode(bytes);

        self.tickets.insert(
            ticket.clone(),
            ArchiveTicket {
                hash: hash.to_string(),
                expires_at: now + ARCHIVE_TICKET_TTL,
            },
        );

        Ok((ticket, ARCHIVE_TICKET_TTL.as_secs()))
    }

    pub fn consume(&mut self, ticket: &str, expected_hash: &str) -> bool {
        self.prune(Instant::now());

        let mut matched = None;
        for (stored_ticket, entry) in &self.tickets {
            let ticket_matches = ct_eq_str(stored_ticket, ticket);
            let hash_matches = ct_eq_str(&entry.hash, expected_hash);
            if ticket_matches && hash_matches {
                matched = Some(stored_ticket.clone());
            }
        }

        match matched {
            Some(ticket) => {
                self.tickets.remove(&ticket);
                true
            }
            None => false,
        }
    }

    fn prune(&mut self, now: Instant) {
        self.tickets.retain(|_, ticket| ticket.expires_at > now);
    }
}

/// Per-client login throttling backed by an in-memory failure window.
#[derive(Default)]
pub struct LoginRateLimiter {
    attempts: HashMap<String, Attempts>,
}

struct Attempts {
    failures: u32,
    first_failure: Instant,
}

impl LoginRateLimiter {
    /// Reject a login attempt while the key is over its failure budget.
    pub fn check(&mut self, key: &str) -> std::result::Result<(), u64> {
        let now = Instant::now();
        self.prune(now);

        let Some(attempts) = self.attempts.get(key) else {
            return Ok(());
        };
        if attempts.failures < LOGIN_MAX_FAILURES {
            return Ok(());
        }

        let elapsed = now.saturating_duration_since(attempts.first_failure);
        Err(LOGIN_WINDOW.saturating_sub(elapsed).as_secs().max(1))
    }

    pub fn record_failure(&mut self, key: &str) {
        let now = Instant::now();
        let attempts = self.attempts.entry(key.to_string()).or_insert(Attempts {
            failures: 0,
            first_failure: now,
        });

        if now.saturating_duration_since(attempts.first_failure) >= LOGIN_WINDOW {
            attempts.failures = 0;
            attempts.first_failure = now;
        }
        attempts.failures = attempts.failures.saturating_add(1);
    }

    pub fn record_success(&mut self, key: &str) {
        self.attempts.remove(key);
    }

    fn prune(&mut self, now: Instant) {
        self.attempts.retain(|_, attempts| {
            now.saturating_duration_since(attempts.first_failure) < LOGIN_WINDOW
        });
    }
}

pub fn load(path: &Path) -> Result<AuthData> {
    match std::fs::read(path) {
        Ok(raw) => serde_json::from_slice(&raw)
            .with_context(|| format!("could not parse {}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(AuthData::default()),
        Err(error) => Err(error).with_context(|| format!("could not read {}", path.display())),
    }
}

pub fn save(path: &Path, data: &AuthData) -> Result<()> {
    crate::config::write_private_json_sync(path, data)
}

/// Extract the session token from the cookie header.
pub fn extract_session_cookie(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find_map(|(name, value)| (name.trim() == SESSION_COOKIE).then_some(value.trim()))
        .filter(|token| !token.is_empty())
}

/// Extract the credentials from an `Authorization: Bearer …` header.
pub fn extract_bearer_token(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, credentials) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let credentials = credentials.trim();
    (!credentials.is_empty()).then_some(credentials)
}

pub fn session_cookie_header(token: &str, secure: bool) -> String {
    let secure = if secure { "; Secure" } else { "" };
    format!(
        "{SESSION_COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={}{secure}",
        SESSION_TTL.as_secs()
    )
}

pub fn clear_session_cookie_header(secure: bool) -> String {
    let secure = if secure { "; Secure" } else { "" };
    format!("{SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0{secure}")
}

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("system randomness is unavailable");
    URL_SAFE_NO_PAD.encode(bytes)
}

pub(crate) fn ct_eq_str(left: &str, right: &str) -> bool {
    left.len() == right.len() && bool::from(left.as_bytes().ct_eq(right.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn device(name: Option<&str>) -> (String, DeviceRecord) {
        mint_device(name).unwrap()
    }

    #[test]
    fn argon2id_passwords_verify_and_use_unique_salts() {
        let password = "correct horse battery staple";
        let first = hash_password(password).unwrap();
        let second = hash_password(password).unwrap();

        assert!(first.starts_with("$argon2id$"));
        assert!(first != second);
        assert!(verify_password(password, &first));
        assert!(verify_password(password, &second));
        assert!(!verify_password("wrong password", &first));
        assert!(!verify_password(password, "not a phc string"));
    }

    #[test]
    fn device_tokens_are_minted_looked_up_touched_and_revoked() {
        let (token, record) = device(Some("  Pixel 9  "));

        assert!(token.starts_with(DEVICE_TOKEN_PREFIX));
        assert_eq!(record.name, "Pixel 9");
        assert_eq!(record.token_hash, sha256_hex(&token));
        assert_eq!(record.last_used_at, None);

        let mut data = AuthData {
            admin: None,
            devices: vec![record.clone()],
        };
        assert_eq!(
            data.find_device_by_token(&token).map(|device| &device.id),
            Some(&record.id)
        );
        assert!(data.find_device_by_token("rmg_wrong").is_none());
        assert!(data.find_device_by_token("").is_none());

        assert!(data.touch_device(&record.id, record.created_at));
        assert!(!data.touch_device(&record.id, record.created_at + 30));
        assert!(data.touch_device(&record.id, record.created_at + 61));

        assert!(data.revoke_device(&record.id));
        assert!(!data.revoke_device(&record.id));
        assert!(data.find_device_by_token(&token).is_none());
    }

    #[test]
    fn device_names_default_and_are_limited() {
        let (_, default) = device(None);
        assert_eq!(default.name, "Device");
        let (_, blank) = device(Some("   "));
        assert_eq!(blank.name, "Device");

        let long = "x".repeat(200);
        let (_, limited) = device(Some(&long));
        assert_eq!(limited.name.chars().count(), DEVICE_NAME_LIMIT);
    }

    #[test]
    fn sessions_expire_and_can_be_revoked() {
        let mut store = SessionStore::default();
        let first = store.create("admin");
        let second = store.create("admin");

        assert_eq!(store.validate(&first).as_deref(), Some("admin"));
        assert_eq!(store.validate(&second).as_deref(), Some("admin"));
        assert!(store.validate("not-a-session").is_none());

        store.revoke(&first);
        assert!(store.validate(&first).is_none());
        assert!(store.validate(&second).is_some());

        store.sessions.get_mut(&second).unwrap().expires_at =
            Instant::now() - Duration::from_secs(1);
        assert!(store.validate(&second).is_none());

        let third = store.create("admin");
        store.revoke_all();
        assert!(store.validate(&third).is_none());
    }

    #[test]
    fn session_cookies_are_hardened() {
        let cookie = session_cookie_header("abc", false);
        assert_eq!(
            cookie,
            "remagnet_session=abc; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800"
        );
        assert!(session_cookie_header("abc", true).ends_with("; Secure"));
        assert_eq!(
            clear_session_cookie_header(false),
            "remagnet_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
        );
        assert!(clear_session_cookie_header(true).ends_with("; Secure"));

        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("other=1; remagnet_session=token-value; x=2"),
        );
        assert_eq!(extract_session_cookie(&headers), Some("token-value"));

        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer  device-token "),
        );
        assert_eq!(extract_bearer_token(&headers), Some("device-token"));

        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Basic device-token"),
        );
        assert_eq!(extract_bearer_token(&headers), None);
    }

    #[test]
    fn archive_tickets_are_single_use_and_bound_to_a_hash() {
        let mut store = ArchiveTicketStore::default();
        let hash = "a".repeat(40);
        let (ticket, ttl) = store.create(&hash).unwrap();

        assert_eq!(ttl, 60);
        assert!(!store.consume(&ticket, &"b".repeat(40)));
        assert!(!store.consume("wrong-ticket", &hash));
        assert!(store.consume(&ticket, &hash));
        assert!(!store.consume(&ticket, &hash));
    }

    #[test]
    fn expired_archive_tickets_are_rejected() {
        let mut store = ArchiveTicketStore::default();
        let (ticket, _) = store.create("hash").unwrap();
        store.tickets.get_mut(&ticket).unwrap().expires_at =
            Instant::now() - Duration::from_secs(1);

        assert!(!store.consume(&ticket, "hash"));
    }

    #[test]
    fn login_rate_limiter_blocks_after_five_failures() {
        let mut limiter = LoginRateLimiter::default();
        let key = "203.0.113.7";

        for _ in 0..(LOGIN_MAX_FAILURES - 1) {
            limiter.record_failure(key);
            assert!(limiter.check(key).is_ok());
        }

        limiter.record_failure(key);
        let retry = limiter.check(key).unwrap_err();
        assert!(retry > 0 && retry <= LOGIN_WINDOW.as_secs());

        limiter.record_success(key);
        assert!(limiter.check(key).is_ok());
    }

    #[test]
    fn login_failure_windows_reset() {
        let mut limiter = LoginRateLimiter::default();
        let key = "203.0.113.8";

        for _ in 0..LOGIN_MAX_FAILURES {
            limiter.record_failure(key);
        }
        assert!(limiter.check(key).is_err());

        limiter.attempts.get_mut(key).unwrap().first_failure =
            Instant::now() - LOGIN_WINDOW - Duration::from_secs(1);
        assert!(limiter.check(key).is_ok());
    }

    #[test]
    fn auth_data_round_trips_through_a_0600_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nested/auth.json");

        assert_eq!(load(&path).unwrap(), AuthData::default());

        let (token, record) = device(Some("Laptop"));
        let data = AuthData {
            admin: Some(AdminAccount {
                username: "admin".to_string(),
                password_hash: hash_password("hunter2").unwrap(),
                totp_secret: Some("JBSWY3DPEHPK3PXP".to_string()),
                totp_last_step: Some(42),
                recovery_code_hashes: vec![sha256_hex("ABC")],
            }),
            devices: vec![record],
        };

        save(&path, &data).unwrap();
        let loaded = load(&path).unwrap();
        assert_eq!(loaded, data);
        assert!(loaded.find_device_by_token(&token).is_some());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }
}
