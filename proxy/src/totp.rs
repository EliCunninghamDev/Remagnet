use anyhow::{anyhow, Result};
use hmac::{Hmac, Mac};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

const BASE32_ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const RECOVERY_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const RECOVERY_CODE_COUNT: usize = 8;
const RECOVERY_CODE_LENGTH: usize = 8;

/// TOTP parameters: SHA-1, six digits, thirty-second periods.
pub const TOTP_PERIOD: u64 = 30;
pub const TOTP_DIGITS: u32 = 6;

type HmacSha1 = Hmac<Sha1>;

/// Encode bytes as RFC 4648 base32 (uppercase, no padding).
pub fn base32_encode(data: &[u8]) -> String {
    let mut output = String::with_capacity((data.len() * 8).div_ceil(5));
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;

    for byte in data {
        buffer = (buffer << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            let index = ((buffer >> bits) & 0x1F) as usize;
            output.push(BASE32_ALPHABET[index] as char);
        }
        buffer &= (1u32 << bits) - 1;
    }

    if bits > 0 {
        let index = ((buffer << (5 - bits)) & 0x1F) as usize;
        output.push(BASE32_ALPHABET[index] as char);
    }

    output
}

/// Decode RFC 4648 base32, tolerating lowercase, whitespace, and padding.
///
/// Returns `None` for characters outside the alphabet or non-canonical trailing
/// bits, so a mistyped secret is rejected instead of silently decoding.
pub fn base32_decode(input: &str) -> Option<Vec<u8>> {
    let mut output = Vec::with_capacity(input.len() * 5 / 8);
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;

    for character in input.chars() {
        if character.is_ascii_whitespace() || character == '-' {
            continue;
        }
        if character == '=' {
            continue;
        }

        let value = match character.to_ascii_uppercase() {
            'A'..='Z' => (character.to_ascii_uppercase() as u8) - b'A',
            '2'..='7' => (character as u8) - b'2' + 26,
            _ => return None,
        };

        buffer = (buffer << 5) | u32::from(value);
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            output.push((buffer >> bits) as u8);
            buffer &= (1u32 << bits) - 1;
        }
    }

    // Valid base32 leaves fewer than five bits; anything else is truncated.
    if bits >= 5 || buffer != 0 {
        return None;
    }

    Some(output)
}

/// Generate a 160-bit TOTP secret, base32 encoded without padding.
pub fn generate_secret() -> Result<String> {
    let mut bytes = [0u8; 20];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| anyhow!("could not read randomness: {error}"))?;
    Ok(base32_encode(&bytes))
}

/// The provisioning URI an authenticator app scans.
pub fn otpauth_uri(username: &str, secret: &str) -> String {
    let encoded_username = utf8_percent_encode(username, NON_ALPHANUMERIC).to_string();
    format!(
        "otpauth://totp/Remagnet:{encoded_username}?secret={secret}&issuer=Remagnet&algorithm=SHA1&digits={TOTP_DIGITS}&period={TOTP_PERIOD}"
    )
}

/// Verify a TOTP code against the current thirty-second step.
///
/// Codes from the previous and next step are accepted to tolerate clock skew.
/// A code whose step is at or below `last_used_step` is rejected so a captured
/// code cannot be replayed.
pub fn verify_code(
    secret_b32: &str,
    code: &str,
    now_secs: u64,
    last_used_step: Option<u64>,
) -> Option<u64> {
    let secret = base32_decode(secret_b32)?;

    let normalized: String = code
        .chars()
        .filter(|character| !character.is_ascii_whitespace() && *character != '-')
        .collect();
    if normalized.len() != TOTP_DIGITS as usize
        || !normalized.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }

    let current_step = now_secs / TOTP_PERIOD;
    let first_step = current_step.saturating_sub(1);
    let last_step = current_step.saturating_add(1);

    let mut matched = None;
    for step in first_step..=last_step {
        let expected = hotp(&secret, step);
        if bool::from(expected.as_bytes().ct_eq(normalized.as_bytes())) && matched.is_none() {
            matched = Some(step);
        }
    }

    let step = matched?;
    match last_used_step {
        Some(last_used) if step <= last_used => None,
        _ => Some(step),
    }
}

/// Generate eight single-use recovery codes in `XXXX-XXXX` form.
pub fn generate_recovery_codes() -> Result<Vec<String>> {
    let mut codes = Vec::with_capacity(RECOVERY_CODE_COUNT);
    for _ in 0..RECOVERY_CODE_COUNT {
        let mut bytes = [0u8; RECOVERY_CODE_LENGTH];
        getrandom::getrandom(&mut bytes)
            .map_err(|error| anyhow!("could not read randomness: {error}"))?;
        let code: String = bytes
            .iter()
            .map(|byte| RECOVERY_ALPHABET[usize::from(*byte) % RECOVERY_ALPHABET.len()] as char)
            .collect();
        codes.push(format!("{}-{}", &code[..4], &code[4..]));
    }
    Ok(codes)
}

/// Normalize a recovery code and return its SHA-256 hash as lowercase hex.
pub fn hash_recovery_code(code: &str) -> String {
    let normalized: String = code
        .chars()
        .filter(|character| !character.is_whitespace() && *character != '-')
        .flat_map(char::to_uppercase)
        .collect();
    let digest = Sha256::digest(normalized.as_bytes());
    to_hex(&digest)
}

fn hotp(secret: &[u8], step: u64) -> String {
    let mut mac = HmacSha1::new_from_slice(secret).expect("HMAC accepts keys of any length");
    mac.update(&step.to_be_bytes());
    let digest = mac.finalize().into_bytes();

    let offset = usize::from(digest[19] & 0x0F);
    let binary = (u32::from(digest[offset] & 0x7F) << 24)
        | (u32::from(digest[offset + 1]) << 16)
        | (u32::from(digest[offset + 2]) << 8)
        | u32::from(digest[offset + 3]);

    format!("{:06}", binary % 1_000_000)
}

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[usize::from(byte >> 4)] as char);
        output.push(HEX[usize::from(byte & 0x0F)] as char);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    /// "12345678901234567890" in base32: the RFC 6238 SHA-1 seed.
    const RFC_SECRET: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

    #[test]
    fn base32_round_trips_and_tolerates_formatting() {
        let bytes = b"hello, remagnet";
        let encoded = base32_encode(bytes);
        assert_eq!(encoded, encoded.to_ascii_uppercase());
        assert!(!encoded.contains('='));
        assert_eq!(base32_decode(&encoded).unwrap(), bytes);

        let formatted = format!("{} ", encoded.to_ascii_lowercase());
        assert_eq!(base32_decode(&formatted).unwrap(), bytes);
        assert_eq!(base32_decode("MZXW6===").unwrap(), b"foo");
        assert!(base32_decode("MZXW6!").is_none());
        assert!(base32_decode("A").is_none());
    }

    #[test]
    fn secrets_are_twenty_random_base32_bytes() {
        let secret = generate_secret().unwrap();
        assert_eq!(secret.len(), 32);
        assert_eq!(base32_decode(&secret).unwrap().len(), 20);
        assert_ne!(secret, generate_secret().unwrap());
    }

    #[test]
    fn otpauth_uri_matches_the_authenticator_format() {
        let uri = otpauth_uri("admin@example.com", RFC_SECRET);
        assert_eq!(
            uri,
            format!(
                "otpauth://totp/Remagnet:admin%40example%2Ecom?secret={RFC_SECRET}&issuer=Remagnet&algorithm=SHA1&digits=6&period=30"
            )
        );
        assert!(otpauth_uri("a b", RFC_SECRET).contains("Remagnet:a%20b?"));
    }

    #[test]
    fn matches_rfc_6238_test_vectors() {
        // The RFC vectors use eight digits; the six-digit code is the tail.
        for (time, expected) in [
            (59u64, "287082"),
            (1_111_111_109, "081804"),
            (1_111_111_111, "050471"),
            (1_234_567_890, "005924"),
            (2_000_000_000, "279037"),
            (20_000_000_000, "353130"),
        ] {
            assert_eq!(
                verify_code(RFC_SECRET, expected, time, None),
                Some(time / TOTP_PERIOD),
                "code at {time}"
            );
        }
    }

    #[test]
    fn accepts_one_step_of_clock_skew_only() {
        let secret = base32_decode(RFC_SECRET).unwrap();
        let now = 10 * TOTP_PERIOD;

        for step in [9u64, 10, 11] {
            let code = hotp(&secret, step);
            assert_eq!(verify_code(RFC_SECRET, &code, now, None), Some(step));
        }
        assert_eq!(verify_code(RFC_SECRET, &hotp(&secret, 8), now, None), None);
        assert_eq!(verify_code(RFC_SECRET, &hotp(&secret, 12), now, None), None);
    }

    #[test]
    fn rejects_replayed_steps() {
        let step = 20_000_000;
        let now = step * TOTP_PERIOD;
        let secret = base32_decode(RFC_SECRET).unwrap();
        let code = hotp(&secret, step);

        assert_eq!(verify_code(RFC_SECRET, &code, now, None), Some(step));
        assert_eq!(verify_code(RFC_SECRET, &code, now, Some(step)), None);
        assert_eq!(
            verify_code(RFC_SECRET, &code, now, Some(step.saturating_sub(1))),
            Some(step)
        );
        assert_eq!(
            verify_code(RFC_SECRET, &code, now, Some(step.saturating_add(1))),
            None
        );
    }

    #[test]
    fn rejects_malformed_codes() {
        for code in ["", "12345", "1234567", "abcdef", "12 34 5x"] {
            assert_eq!(verify_code(RFC_SECRET, code, 59, None), None, "{code}");
        }
        assert!(verify_code("not-base32!", "123456", 59, None).is_none());
    }

    #[test]
    fn recovery_codes_are_formatted_and_hash_deterministically() {
        let codes = generate_recovery_codes().unwrap();
        assert_eq!(codes.len(), 8);
        assert_eq!(
            codes.iter().collect::<std::collections::HashSet<_>>().len(),
            8
        );

        for code in &codes {
            let (left, right) = code.split_once('-').unwrap();
            assert_eq!(left.len(), 4);
            assert_eq!(right.len(), 4);
            assert!(code.chars().all(
                |character| character == '-' || RECOVERY_ALPHABET.contains(&(character as u8))
            ));
            assert!(!code.contains(['I', 'O', '0', '1']));
        }

        let hash = hash_recovery_code(&codes[0]);
        assert_eq!(hash.len(), 64);
        assert_eq!(hash, hash_recovery_code(&codes[0].to_ascii_lowercase()));
        assert_eq!(
            hash,
            hash_recovery_code(&codes[0].replace('-', " ").to_ascii_lowercase())
        );
        assert_ne!(hash, hash_recovery_code(&codes[1]));
    }
}
