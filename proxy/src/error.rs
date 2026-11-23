use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

/// Every failure the HTTP surface can report.
///
/// Messages are written for the extension (or a person using the config page),
/// so upstream errors are trimmed and never include credentials.
#[derive(Debug)]
pub enum AppError {
    BadRequest(String),
    Unauthorized,
    Forbidden(String),
    TooManyRequests(String),
    TotpRequired,
    NotFound(String),
    Conflict(String),
    ServiceUnavailable(String),
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
}

impl std::fmt::Display for AppError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadRequest(message)
            | Self::Forbidden(message)
            | Self::TooManyRequests(message)
            | Self::NotFound(message)
            | Self::Conflict(message)
            | Self::ServiceUnavailable(message)
            | Self::Upstream(message)
            | Self::Internal(message) => formatter.write_str(message),
            Self::Unauthorized => formatter.write_str("authentication required"),
            Self::TotpRequired => formatter.write_str("two-factor authentication code required"),
        }
    }
}

impl std::error::Error for AppError {}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, payload) = match self {
            Self::TotpRequired => (
                StatusCode::UNAUTHORIZED,
                json!({
                    "error": "Two-factor authentication code required.",
                    "code": "totp_required",
                }),
            ),
            Self::BadRequest(message) => (StatusCode::BAD_REQUEST, json!({ "error": message })),
            Self::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                json!({ "error": "Authentication required." }),
            ),
            Self::Forbidden(message) => (StatusCode::FORBIDDEN, json!({ "error": message })),
            Self::TooManyRequests(message) => {
                (StatusCode::TOO_MANY_REQUESTS, json!({ "error": message }))
            }
            Self::NotFound(message) => (StatusCode::NOT_FOUND, json!({ "error": message })),
            Self::Conflict(message) => (StatusCode::CONFLICT, json!({ "error": message })),
            Self::ServiceUnavailable(message) => {
                (StatusCode::SERVICE_UNAVAILABLE, json!({ "error": message }))
            }
            Self::Upstream(message) => (StatusCode::BAD_GATEWAY, json!({ "error": message })),
            Self::Internal(message) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": message }),
            ),
        };

        if status.is_server_error() {
            let message = payload
                .get("error")
                .and_then(|value| value.as_str())
                .unwrap_or("request failed");
            tracing::warn!(status = status.as_u16(), message, "request failed");
        }

        (status, Json(payload)).into_response()
    }
}
