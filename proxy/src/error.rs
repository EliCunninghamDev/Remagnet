use axum::{
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

/// Message returned to clients for every unexpected internal failure.
///
/// The technical detail is only ever written to the proxy logs, never to the
/// HTTP response.
pub const INTERNAL_ERROR_MESSAGE: &str =
    "The Remagnet Proxy hit an unexpected internal error. Check the proxy container logs for details.";

/// Longest upstream body included in a client-facing error message.
pub const MAX_UPSTREAM_BODY_CHARS: usize = 300;

/// Every failure the HTTP surface can report.
///
/// Messages are written for the extension (or a person using the config page),
/// so upstream errors are trimmed and never include credentials, raw Rust error
/// chains, or upstream URLs.
#[derive(Debug)]
pub enum AppError {
    BadRequest(String),
    Unauthorized,
    Forbidden(String),
    TooManyRequests { message: String, retry_after: u64 },
    TotpRequired,
    NotFound(String),
    Conflict(String),
    PayloadTooLarge(String),
    ServiceUnavailable(String),
    UpstreamUnreachable(String),
    UpstreamAuth(String),
    Upstream(String),
    Internal(String),
}

impl AppError {
    pub fn internal(error: impl std::fmt::Display) -> Self {
        Self::Internal(error.to_string())
    }

    pub fn upstream(error: impl std::fmt::Display) -> Self {
        Self::Upstream(error.to_string())
    }

    /// Classify a failed `reqwest` request from a torrent client.
    ///
    /// The full technical error is logged server-side. The returned message is
    /// deliberately client-neutral: it never includes the upstream URL or any
    /// part of the underlying error chain.
    pub fn from_reqwest(client_name: &str, error: reqwest::Error) -> Self {
        tracing::warn!(
            client = client_name,
            error = %error,
            "upstream torrent client request failed"
        );

        let technical = error_chain(&error);
        Self::UpstreamUnreachable(upstream_unreachable_message(
            client_name,
            &technical,
            error.is_timeout(),
            error.is_connect(),
        ))
    }

    /// Report a non-success status from a torrent client.
    ///
    /// The body is sanitized and truncated before it is shown; HTML pages and
    /// empty bodies add no detail.
    #[allow(dead_code)] // adopted by the client adapters in the next cleanup batch
    pub fn upstream_status(
        client_name: &str,
        status: reqwest::StatusCode,
        op: &str,
        body: &str,
    ) -> Self {
        let detail = Self::sanitize_upstream_body(body, MAX_UPSTREAM_BODY_CHARS)
            .map(|detail| format!(": {detail}"))
            .unwrap_or_default();
        Self::Upstream(format!("{client_name} returned {status} for {op}{detail}"))
    }

    /// Report a response from a torrent client that could not be decoded.
    #[allow(dead_code)] // adopted by the client adapters in the next cleanup batch
    pub fn upstream_unreadable(client_name: &str) -> Self {
        Self::Upstream(format!(
            "{client_name} returned a response Remagnet Proxy could not read. Check that {client_name} is running and up to date."
        ))
    }

    /// Trim an upstream response body for display in an error message.
    ///
    /// Empty bodies and HTML error pages (for example a torrent client's login
    /// page or reverse-proxy 502 page) are not useful to the caller, so they
    /// return `None`. Long bodies are truncated with an ellipsis.
    pub fn sanitize_upstream_body(body: &str, max_chars: usize) -> Option<String> {
        let body = body.trim();
        if body.is_empty() {
            return None;
        }

        let lower = body.to_ascii_lowercase();
        if lower.starts_with('<') || lower.starts_with("<!doctype") {
            return None;
        }

        let mut sanitized = body.chars().take(max_chars).collect::<String>();
        if body.chars().count() > max_chars {
            sanitized.push('…');
        }
        Some(sanitized)
    }

    /// Stable machine-readable identifier for the error body.
    pub fn code(&self) -> &'static str {
        match self {
            Self::BadRequest(_) => "bad_request",
            Self::Unauthorized => "unauthorized",
            Self::Forbidden(_) => "forbidden",
            Self::NotFound(_) => "not_found",
            Self::Conflict(_) => "conflict",
            Self::PayloadTooLarge(_) => "payload_too_large",
            Self::TooManyRequests { .. } => "rate_limited",
            Self::TotpRequired => "totp_required",
            Self::ServiceUnavailable(_) => "not_configured",
            Self::UpstreamUnreachable(_) => "upstream_unreachable",
            Self::UpstreamAuth(_) => "upstream_auth",
            Self::Upstream(_) => "upstream_error",
            Self::Internal(_) => "internal_error",
        }
    }

    /// HTTP status paired with the error code.
    pub fn status(&self) -> StatusCode {
        match self {
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Unauthorized | Self::TotpRequired => StatusCode::UNAUTHORIZED,
            Self::Forbidden(_) => StatusCode::FORBIDDEN,
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::PayloadTooLarge(_) => StatusCode::PAYLOAD_TOO_LARGE,
            Self::TooManyRequests { .. } => StatusCode::TOO_MANY_REQUESTS,
            Self::ServiceUnavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            Self::UpstreamUnreachable(_) | Self::UpstreamAuth(_) | Self::Upstream(_) => {
                StatusCode::BAD_GATEWAY
            }
            Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadRequest(message)
            | Self::Forbidden(message)
            | Self::NotFound(message)
            | Self::Conflict(message)
            | Self::PayloadTooLarge(message)
            | Self::ServiceUnavailable(message)
            | Self::UpstreamUnreachable(message)
            | Self::UpstreamAuth(message)
            | Self::Upstream(message)
            | Self::Internal(message) => formatter.write_str(message),
            Self::TooManyRequests { message, .. } => formatter.write_str(message),
            Self::Unauthorized => formatter.write_str("authentication required"),
            Self::TotpRequired => formatter.write_str("two-factor authentication code required"),
        }
    }
}

impl std::error::Error for AppError {}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let retry_after = match &self {
            Self::TooManyRequests { retry_after, .. } => Some(*retry_after),
            _ => None,
        };
        let status = self.status();
        let code = self.code();

        let message = match self {
            Self::Internal(detail) => {
                tracing::error!(status = 500, detail = %detail, "internal proxy error");
                INTERNAL_ERROR_MESSAGE.to_string()
            }
            Self::Unauthorized => "Authentication required.".to_string(),
            Self::TotpRequired => "Two-factor authentication code required.".to_string(),
            Self::TooManyRequests { message, .. }
            | Self::BadRequest(message)
            | Self::Forbidden(message)
            | Self::NotFound(message)
            | Self::Conflict(message)
            | Self::PayloadTooLarge(message)
            | Self::ServiceUnavailable(message)
            | Self::UpstreamUnreachable(message)
            | Self::UpstreamAuth(message)
            | Self::Upstream(message) => {
                if status.is_server_error() {
                    tracing::warn!(status = status.as_u16(), message = %message, "request failed");
                }
                message
            }
        };

        let mut response =
            (status, Json(json!({ "error": message, "code": code }))).into_response();
        if let Some(retry_after) = retry_after {
            response.headers_mut().insert(
                header::RETRY_AFTER,
                HeaderValue::from_str(&retry_after.to_string())
                    .unwrap_or_else(|_| HeaderValue::from_static("1")),
            );
        }
        response
    }
}

/// Flatten a `reqwest` error and its source chain into one log line.
fn error_chain(error: &reqwest::Error) -> String {
    let mut chain = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        chain.push_str(": ");
        chain.push_str(&cause.to_string());
        source = cause.source();
    }
    chain
}

/// Pick an actionable, URL-free message for an unreachable torrent client.
fn upstream_unreachable_message(
    client_name: &str,
    technical: &str,
    is_timeout: bool,
    is_connect: bool,
) -> String {
    let haystack = technical.to_ascii_lowercase();

    if is_timeout {
        format!("{client_name} did not respond in time. Check that it is running and reachable from Remagnet Proxy.")
    } else if has_tls_failure(&haystack) {
        format!(
            "TLS handshake with {client_name} failed. Check its HTTPS certificate or use HTTP on a private network."
        )
    } else if has_dns_failure(&haystack) {
        format!(
            "Could not resolve the {client_name} host. Check the client URL in the Remagnet Proxy settings."
        )
    } else if is_connect {
        format!(
            "Could not connect to {client_name}. Check that it is running and reachable from Remagnet Proxy."
        )
    } else {
        format!(
            "Could not reach {client_name}. Check that it is running and reachable from Remagnet Proxy."
        )
    }
}

fn has_tls_failure(haystack: &str) -> bool {
    ["tls", "ssl", "certificate", "handshake"]
        .iter()
        .any(|needle| haystack.contains(needle))
}

fn has_dns_failure(haystack: &str) -> bool {
    ["dns", "lookup", "resolve"]
        .iter()
        .any(|needle| haystack.contains(needle))
}

#[cfg(test)]
mod tests {
    use axum::body::to_bytes;
    use serde_json::Value;

    use super::*;

    async fn respond(error: AppError) -> (StatusCode, Value) {
        let response = error.into_response();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn every_variant_reports_its_status_and_stable_code() {
        let cases = [
            (
                AppError::BadRequest("Bad input.".to_string()),
                StatusCode::BAD_REQUEST,
                "bad_request",
            ),
            (
                AppError::Unauthorized,
                StatusCode::UNAUTHORIZED,
                "unauthorized",
            ),
            (
                AppError::TotpRequired,
                StatusCode::UNAUTHORIZED,
                "totp_required",
            ),
            (
                AppError::Forbidden("Not allowed.".to_string()),
                StatusCode::FORBIDDEN,
                "forbidden",
            ),
            (
                AppError::NotFound("Missing.".to_string()),
                StatusCode::NOT_FOUND,
                "not_found",
            ),
            (
                AppError::Conflict("Already exists.".to_string()),
                StatusCode::CONFLICT,
                "conflict",
            ),
            (
                AppError::PayloadTooLarge("Too big.".to_string()),
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload_too_large",
            ),
            (
                AppError::TooManyRequests {
                    message: "Slow down.".to_string(),
                    retry_after: 5,
                },
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
            ),
            (
                AppError::ServiceUnavailable("Not configured.".to_string()),
                StatusCode::SERVICE_UNAVAILABLE,
                "not_configured",
            ),
            (
                AppError::UpstreamUnreachable("Unreachable.".to_string()),
                StatusCode::BAD_GATEWAY,
                "upstream_unreachable",
            ),
            (
                AppError::UpstreamAuth("Rejected.".to_string()),
                StatusCode::BAD_GATEWAY,
                "upstream_auth",
            ),
            (
                AppError::Upstream("Upstream failed.".to_string()),
                StatusCode::BAD_GATEWAY,
                "upstream_error",
            ),
            (
                AppError::Internal("secret detail".to_string()),
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
            ),
        ];

        for (error, expected_status, expected_code) in cases {
            let (status, body) = respond(error).await;
            assert_eq!(status, expected_status, "status for {expected_code}");
            assert_eq!(body["code"], expected_code);
            assert!(
                body["error"]
                    .as_str()
                    .is_some_and(|message| !message.is_empty()),
                "{expected_code} must carry a message"
            );
        }
    }

    #[tokio::test]
    async fn rate_limited_keeps_the_retry_after_header() {
        let response = AppError::TooManyRequests {
            message: "Slow down.".to_string(),
            retry_after: 17,
        }
        .into_response();

        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers()[header::RETRY_AFTER], "17");
    }

    #[tokio::test]
    async fn internal_errors_hide_the_raw_detail() {
        let (status, body) = respond(AppError::Internal(
            "could not read /etc/remagnet/auth.json: password=hunter2".to_string(),
        ))
        .await;

        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body["code"], "internal_error");
        assert_eq!(body["error"], INTERNAL_ERROR_MESSAGE);

        let serialized = body.to_string();
        assert!(!serialized.contains("hunter2"));
        assert!(!serialized.contains("/etc/remagnet"));
    }

    #[test]
    fn upstream_classification_never_leaks_urls_or_raw_errors() {
        let cases = [
            (
                "operation timed out: https://admin:secret@qbit.example.com:8080/api/v2",
                true,
                false,
                "did not respond in time",
            ),
            (
                "error sending request for url (https://qbit.example.com:8080): tls handshake failure: certificate verify failed",
                false,
                true,
                "TLS handshake",
            ),
            (
                "dns error: failed to lookup address information for http://qbittorrent.example.com",
                false,
                true,
                "Could not resolve",
            ),
            (
                "tcp connect error: Connection refused (os error 111) to http://qbit.example.com:8080",
                false,
                true,
                "Could not connect",
            ),
            (
                "error decoding response body at https://qbit.example.com:8080/api/v2",
                false,
                false,
                "Could not reach",
            ),
        ];

        for (technical, is_timeout, is_connect, expected) in cases {
            let message =
                upstream_unreachable_message("qBittorrent", technical, is_timeout, is_connect);
            assert!(message.contains(expected), "{message} lacks {expected}");
            for leak in [
                "http://",
                "https://",
                "qbit.example.com",
                "qbittorrent.example.com",
                "admin",
                "secret",
                "os error",
            ] {
                assert!(!message.contains(leak), "{message} leaked {leak}");
            }
        }
    }

    #[test]
    fn sanitizes_upstream_bodies() {
        assert_eq!(AppError::sanitize_upstream_body("", 10), None);
        assert_eq!(AppError::sanitize_upstream_body("   \n\t ", 10), None);
        assert_eq!(
            AppError::sanitize_upstream_body("  <!DOCTYPE html><html>oops</html>  ", 300),
            None
        );
        assert_eq!(
            AppError::sanitize_upstream_body("<html><body>login</body></html>", 300),
            None
        );
        assert_eq!(
            AppError::sanitize_upstream_body("  Bad request  ", 300).as_deref(),
            Some("Bad request")
        );
        assert_eq!(
            AppError::sanitize_upstream_body("abcdefghij", 4).as_deref(),
            Some("abcd…")
        );
    }

    #[tokio::test]
    async fn real_connect_failures_become_upstream_unreachable() {
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(2))
            .build()
            .unwrap();
        let error = client
            .get("http://127.0.0.1:1/api/v2/app/version?token=secret")
            .send()
            .await
            .unwrap_err();

        let error = AppError::from_reqwest("qBittorrent", error);
        assert_eq!(error.code(), "upstream_unreachable");
        let message = error.to_string();
        assert!(message.contains("qBittorrent"));
        assert!(!message.contains("127.0.0.1"));
        assert!(!message.contains("secret"));
    }
}
