use std::collections::HashMap;

use axum::http::{header::AUTHORIZATION, HeaderMap};
use subtle::ConstantTimeEq;

/// Accept the token as `Authorization: Bearer …` or as `?token=…`.
///
/// Firefox can attach headers to `browser.downloads.download`; the query string
/// is a fallback for browsers that cannot. Both comparisons are constant-time.
pub fn is_authorized(headers: &HeaderMap, query: &HashMap<String, String>, token: &str) -> bool {
    if token.is_empty() {
        return false;
    }

    let bearer = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_bearer);

    bearer.is_some_and(|candidate| token_eq(candidate, token))
        || query
            .get("token")
            .is_some_and(|candidate| token_eq(candidate, token))
}

fn parse_bearer(value: &str) -> Option<&str> {
    let (scheme, credentials) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let credentials = credentials.trim();
    (!credentials.is_empty()).then_some(credentials)
}

fn token_eq(candidate: &str, expected: &str) -> bool {
    candidate.len() == expected.len() && candidate.as_bytes().ct_eq(expected.as_bytes()).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, HeaderValue::from_str(value).unwrap());
        headers
    }

    #[test]
    fn accepts_bearer_case_insensitively() {
        let query = HashMap::new();
        assert!(is_authorized(
            &headers("Bearer secret-token-1234"),
            &query,
            "secret-token-1234"
        ));
        assert!(is_authorized(
            &headers("bearer secret-token-1234"),
            &query,
            "secret-token-1234"
        ));
    }

    #[test]
    fn accepts_query_token() {
        let query = HashMap::from([("token".to_string(), "secret-token-1234".to_string())]);
        assert!(is_authorized(
            &HeaderMap::new(),
            &query,
            "secret-token-1234"
        ));
    }

    #[test]
    fn rejects_missing_wrong_or_empty_tokens() {
        let query = HashMap::new();
        assert!(!is_authorized(
            &HeaderMap::new(),
            &query,
            "secret-token-1234"
        ));
        assert!(!is_authorized(
            &headers("Bearer wrong-token-1234"),
            &query,
            "secret-token-1234"
        ));
        assert!(!is_authorized(
            &headers("Basic secret-token-1234"),
            &query,
            "secret-token-1234"
        ));
        assert!(!is_authorized(
            &headers("Bearer secret-token-1234"),
            &query,
            ""
        ));
    }
}
