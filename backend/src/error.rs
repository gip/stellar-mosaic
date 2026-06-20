use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

/// Application error that renders as a JSON body with an appropriate status code.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("unauthorized: {0}")]
    Unauthorized(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("stellar cli error: {0}")]
    Stellar(String),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Other(anyhow::anyhow!(e))
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, msg) = match &self {
            AppError::NotFound(m) => (StatusCode::NOT_FOUND, m.clone()),
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, m.clone()),
            AppError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m.clone()),
            AppError::Conflict(m) => (StatusCode::CONFLICT, m.clone()),
            AppError::Stellar(m) => (StatusCode::BAD_GATEWAY, m.clone()),
            AppError::Other(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        };
        tracing::warn!(error = %self, "request failed");
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;
