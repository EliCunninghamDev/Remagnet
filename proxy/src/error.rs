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
            | Self::NotFound(message)
            | Self::Conflict(message)
            | Self::ServiceUnavailable(message)
            | Self::Upstream(message)
            | Self::Internal(message) => formatter.write_str(message),
            Self::Unauthorized => formatter.write_str("missing or invalid bridge token"),
        }
    }
}

impl std::error::Error for AppError {}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::BadRequest(message) => (StatusCode::BAD_REQUEST, message),
            Self::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "Missing or invalid bridge token.".to_string(),
            ),
            Self::NotFound(message) => (StatusCode::NOT_FOUND, message),
            Self::Conflict(message) => (StatusCode::CONFLICT, message),
            Self::ServiceUnavailable(message) => (StatusCode::SERVICE_UNAVAILABLE, message),
            Self::Upstream(message) => (StatusCode::BAD_GATEWAY, message),
            Self::Internal(message) => (StatusCode::INTERNAL_SERVER_ERROR, message),
        };

        if status.is_server_error() {
            tracing::warn!(status = status.as_u16(), message, "request failed");
        }

        (status, Json(json!({ "error": message }))).into_response()
    }
}
