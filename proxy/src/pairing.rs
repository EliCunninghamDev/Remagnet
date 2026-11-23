use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use qrcode::{render::svg, EcLevel, QrCode};
use serde::Serialize;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use url::{form_urlencoded, Url};

/// How long a displayed pairing code stays valid. The extension rotates the
/// code before this deadline, and the proxy refuses claims after it.
pub const PAIRING_TTL: Duration = Duration::from_secs(60);

/// A few concurrent codes are enough for one extension tab; the oldest is
/// dropped when the cap is reached so a stuck tab cannot grow memory forever.
const MAX_SESSIONS: usize = 16;

struct Session {
    secret: [u8; 32],
    expires_at: Instant,
}

/// In-memory pairing sessions.
///
/// Secrets are held only for the code's lifetime and never written to disk.
/// Restarting the proxy invalidates every outstanding code.
#[derive(Default)]
pub struct PairingStore {
    sessions: HashMap<String, Session>,
}

pub struct CreatedPairing {
    pub id: String,
    pub code: String,
    pub expires_in: u64,
}

#[derive(Debug, Serialize)]
pub struct EncryptedPayload {
    /// AES-GCM nonce, base64url without padding.
    pub iv: String,
    /// Ciphertext and authentication tag, base64url without padding.
    pub data: String,
}

impl PairingStore {
    pub fn create(&mut self) -> Result<CreatedPairing> {
        let now = Instant::now();
        self.prune(now);

        if self.sessions.len() >= MAX_SESSIONS {
            if let Some(oldest) = self
                .sessions
                .iter()
                .min_by_key(|(_, session)| session.expires_at)
                .map(|(id, _)| id.clone())
            {
                self.sessions.remove(&oldest);
            }
        }

        let mut id_bytes = [0u8; 16];
        let mut secret = [0u8; 32];
        random_bytes(&mut id_bytes)?;
        random_bytes(&mut secret)?;

        let id = encode(&id_bytes);
        self.sessions.insert(
            id.clone(),
            Session {
                secret,
                expires_at: now + PAIRING_TTL,
            },
        );

        Ok(CreatedPairing {
            id,
            code: encode(&secret),
            expires_in: PAIRING_TTL.as_secs(),
        })
    }

    pub fn revoke(&mut self, id: &str) -> bool {
        self.sessions.remove(id).is_some()
    }

    /// Verify a claim proof and consume the session.
    ///
    /// The code itself is never sent back to the proxy. The client sends
    /// `SHA-256(code)`, so request logs and TLS-terminating proxies cannot see
    /// the value used to derive the response encryption key.
    pub fn claim(&mut self, id: &str, proof: &str) -> Option<[u8; 32]> {
        self.prune(Instant::now());
        let session = self.sessions.get(id)?;

        let expected = Sha256::digest(session.secret);
        let actual = URL_SAFE_NO_PAD.decode(proof).ok()?;
        if expected.as_slice().ct_eq(actual.as_slice()).unwrap_u8() != 1 {
            return None;
        }

        let secret = session.secret;
        self.sessions.remove(id);
        Some(secret)
    }

    fn prune(&mut self, now: Instant) {
        self.sessions.retain(|_, session| session.expires_at > now);
    }
}

/// Encrypt the connection payload for the device that scanned the code.
///
/// The key never crosses the network: both sides derive it from the pairing
/// code and the session id. TLS still protects the request itself, but a
/// logged response stays useless without the scanned code.
pub fn encrypt(secret: &[u8; 32], id: &str, plaintext: &[u8]) -> Result<EncryptedPayload> {
    let key = derive_key(secret, id);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| anyhow!("invalid pairing key"))?;

    let mut nonce = [0u8; 12];
    random_bytes(&mut nonce)?;

    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext)
        .map_err(|_| anyhow!("could not encrypt the pairing payload"))?;

    Ok(EncryptedPayload {
        iv: encode(&nonce),
        data: encode(&ciphertext),
    })
}

/// The key both the proxy and the Android app derive after a successful claim.
pub fn derive_key(secret: &[u8; 32], id: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"remagnet-pair-v1");
    hasher.update(id.as_bytes());
    hasher.update(secret);
    hasher.finalize().into()
}

/// `SHA-256(code)` in the base64url form the claim endpoint expects.
#[cfg(test)]
pub fn proof(secret: &[u8; 32]) -> String {
    encode(&Sha256::digest(secret))
}

/// Check a proxy origin and return it without a path or trailing slash.
///
/// Pairing carries credentials, so a plain HTTP origin is only allowed for
/// loopback and the Android emulator host. The phone applies the same rule; if
/// this endpoint accepted a LAN origin the app would reject the code later.
pub fn normalize_origin(raw: &str) -> Result<String> {
    if raw.len() > 2048 {
        bail!("The pairing URL is too long.");
    }

    let url = Url::parse(raw.trim()).context("The pairing URL is not valid.")?;
    if !matches!(url.scheme(), "http" | "https") {
        bail!("The pairing URL must use http:// or https://.");
    }
    if !url.username().is_empty() || url.password().is_some() {
        bail!("The pairing URL must not contain credentials.");
    }
    if url.query().is_some() || url.fragment().is_some() {
        bail!("The pairing URL must not contain a query or fragment.");
    }
    if url.path() != "/" && !url.path().is_empty() {
        bail!("The pairing URL must be an origin, without a path.");
    }

    let host = url
        .host_str()
        .filter(|host| !host.is_empty())
        .context("The pairing URL needs a host.")?;
    let loopback = matches!(host, "127.0.0.1" | "localhost" | "::1" | "10.0.2.2");
    if url.scheme() != "https" && !loopback {
        bail!("Pairing needs an HTTPS Remagnet Proxy URL.");
    }

    Ok(url.origin().ascii_serialization())
}

/// The `remagnet://pair` link encoded in the QR image.
pub fn pairing_uri(origin: &str, id: &str, code: &str) -> String {
    let mut serializer = form_urlencoded::Serializer::new(String::new());
    serializer.append_pair("url", origin);
    serializer.append_pair("id", id);
    serializer.append_pair("code", code);
    format!("remagnet://pair?{}", serializer.finish())
}

/// Render the pairing link as an inline SVG.
///
/// Kept black on white regardless of the page theme so a camera can read it,
/// and generated here rather than by a third-party QR service.
pub fn qr_svg(uri: &str) -> Result<String> {
    let code = QrCode::with_error_correction_level(uri.as_bytes(), EcLevel::M)
        .map_err(|error| anyhow!("could not encode the pairing QR code: {error}"))?;
    let svg = code
        .render::<svg::Color>()
        .quiet_zone(false)
        .min_dimensions(240, 240)
        .dark_color(svg::Color("#000000"))
        .light_color(svg::Color("#ffffff"))
        .build();

    // The renderer prefixes an XML declaration, which is noise inside HTML.
    Ok(match svg.find("<svg") {
        Some(start) => svg[start..].to_string(),
        None => svg,
    })
}

fn random_bytes(buffer: &mut [u8]) -> Result<()> {
    getrandom::getrandom(buffer).map_err(|error| anyhow!("could not read randomness: {error}"))
}

fn encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::aead::Aead;

    #[test]
    fn a_created_code_can_be_claimed_once() {
        let mut store = PairingStore::default();
        let created = store.create().unwrap();
        let secret: [u8; 32] = URL_SAFE_NO_PAD
            .decode(created.code.as_bytes())
            .unwrap()
            .try_into()
            .unwrap();

        assert!(store.claim(&created.id, &proof(&secret)).is_some());
        assert!(store.claim(&created.id, &proof(&secret)).is_none());
    }

    #[test]
    fn a_wrong_proof_does_not_consume_the_session() {
        let mut store = PairingStore::default();
        let created = store.create().unwrap();
        let secret: [u8; 32] = URL_SAFE_NO_PAD
            .decode(created.code.as_bytes())
            .unwrap()
            .try_into()
            .unwrap();

        assert!(store.claim(&created.id, &"A".repeat(43)).is_none());
        assert!(store.claim(&created.id, &proof(&secret)).is_some());
    }

    #[test]
    fn expired_sessions_are_not_claimable() {
        let mut store = PairingStore::default();
        let created = store.create().unwrap();
        let secret: [u8; 32] = URL_SAFE_NO_PAD
            .decode(created.code.as_bytes())
            .unwrap()
            .try_into()
            .unwrap();

        store.sessions.get_mut(&created.id).unwrap().expires_at =
            Instant::now() - Duration::from_secs(1);

        assert!(store.claim(&created.id, &proof(&secret)).is_none());
    }

    #[test]
    fn encrypted_payload_round_trips_with_the_derived_key() {
        let secret = [7u8; 32];
        let id = "session-id";
        let encrypted = encrypt(&secret, id, b"secret payload").unwrap();

        let key = derive_key(&secret, id);
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let nonce = URL_SAFE_NO_PAD.decode(encrypted.iv).unwrap();
        let ciphertext = URL_SAFE_NO_PAD.decode(encrypted.data).unwrap();
        let plaintext = cipher
            .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
            .unwrap();
        assert_eq!(plaintext, b"secret payload");
    }

    #[test]
    fn origins_are_trimmed_to_an_https_origin() {
        assert_eq!(
            normalize_origin("https://remagnet.example.com/").unwrap(),
            "https://remagnet.example.com"
        );
        assert_eq!(
            normalize_origin("http://127.0.0.1:8080").unwrap(),
            "http://127.0.0.1:8080"
        );
        assert_eq!(
            normalize_origin("http://10.0.2.2:8080").unwrap(),
            "http://10.0.2.2:8080"
        );
    }

    #[test]
    fn pairing_origins_must_not_carry_credentials_or_paths() {
        for origin in [
            "http://proxy.example.com",
            "https://user:pass@proxy.example.com",
            "https://proxy.example.com/path",
            "https://proxy.example.com?x=1",
            "ftp://proxy.example.com",
            "not a url",
        ] {
            assert!(normalize_origin(origin).is_err(), "{origin} should fail");
        }
    }

    #[test]
    fn pairing_link_escapes_each_value() {
        let uri = pairing_uri("https://proxy.example.com", "session/1", "a+b");

        assert_eq!(
            uri,
            "remagnet://pair?url=https%3A%2F%2Fproxy.example.com&id=session%2F1&code=a%2Bb"
        );
    }

    #[test]
    fn qr_svg_is_inline_and_black_on_white() {
        let uri = pairing_uri("https://proxy.example.com", "session-id", "secret");
        let svg = qr_svg(&uri).unwrap();

        assert!(svg.starts_with("<svg"));
        assert!(!svg.contains("<?xml"));
        assert!(svg.contains("#000000"));
        assert!(svg.contains("#ffffff"));
    }
}
