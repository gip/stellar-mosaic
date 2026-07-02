//! HTTP surface of the prove service: token-gated async submit + poll.
//!
//!   POST /prove/base-deposit           { job_id, bridge, deposit_id } -> { status }
//!   GET  /prove/base-deposit/:job_id                                  -> { status, seal_hex?, ... }
//!
//! `status` is one of `running | done | error | not_started`. `done` carries the proof artifacts;
//! `error` carries a message. The caller (the MCP worker) owns finality waiting and Stellar submission.

use crate::error::{AppError, AppResult};
use crate::prove_manager::ProveStatus;
use crate::prover::BaseDepositProof;
use crate::AppState;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Deserialize)]
pub struct SubmitProve {
    /// Stable idempotency key (the MCP base-shield job id). Reused for the on-disk artifact dir.
    pub job_id: String,
    pub bridge: String,
    pub deposit_id: i64,
}

#[derive(Debug, Default, Serialize)]
pub struct ProveStatusResponse {
    /// `running` | `done` | `error` | `not_started`.
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seal_hex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub journal_hex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_number: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl From<ProveStatus> for ProveStatusResponse {
    fn from(s: ProveStatus) -> Self {
        match s {
            ProveStatus::Running => ProveStatusResponse {
                status: "running".into(),
                ..Default::default()
            },
            ProveStatus::NotStarted => ProveStatusResponse {
                status: "not_started".into(),
                ..Default::default()
            },
            ProveStatus::Error(e) => ProveStatusResponse {
                status: "error".into(),
                error: Some(e),
                ..Default::default()
            },
            ProveStatus::Done(BaseDepositProof {
                seal_hex,
                journal_hex,
                block_number,
                block_hash,
            }) => ProveStatusResponse {
                status: "done".into(),
                seal_hex: Some(seal_hex),
                journal_hex: Some(journal_hex),
                block_number: Some(block_number),
                block_hash: Some(block_hash),
                ..Default::default()
            },
        }
    }
}

fn require_prover_token(headers: &HeaderMap, st: &AppState) -> AppResult<()> {
    let Some(expected) = st.config.prover_token.as_deref() else {
        return Err(AppError::Unauthorized(
            "MOSAIC_PROVER_TOKEN is not configured".into(),
        ));
    };
    let actual = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(|| AppError::Unauthorized("bearer token required".into()))?;
    if actual != expected {
        return Err(AppError::Unauthorized("invalid prover token".into()));
    }
    Ok(())
}

/// Idempotently start (or observe) a prove job; returns its current status immediately.
pub async fn submit_prove(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<SubmitProve>,
) -> AppResult<Json<ProveStatusResponse>> {
    require_prover_token(&headers, &st)?;
    if st.config.base_rpc.is_none() {
        return Err(AppError::BadRequest(
            "MOSAIC_BASE_RPC is not configured; proving is unavailable".into(),
        ));
    }
    if body.job_id.is_empty() || body.bridge.is_empty() {
        return Err(AppError::BadRequest("job_id and bridge are required".into()));
    }
    let status = st
        .prover
        .submit(body.job_id, body.bridge, body.deposit_id);
    Ok(Json(status.into()))
}

/// Poll a prove job by its `job_id` without starting anything.
pub async fn get_prove(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(job_id): Path<String>,
) -> AppResult<Json<ProveStatusResponse>> {
    require_prover_token(&headers, &st)?;
    Ok(Json(st.prover.status(&job_id).into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::prove_manager::ProveManager;
    use axum::http::header::AUTHORIZATION;
    use std::path::PathBuf;

    fn state(token: Option<&str>) -> Arc<AppState> {
        let config = Config {
            bind: "127.0.0.1:0".into(),
            base_rpc: Some("https://rpc.example".into()),
            cast_bin: "cast".into(),
            prover_dir: PathBuf::from("/tmp/does-not-matter"),
            prover_token: token.map(|s| s.to_string()),
        };
        Arc::new(AppState {
            prover: ProveManager::new(config.clone()),
            config,
        })
    }

    fn headers(bearer: Option<&str>) -> HeaderMap {
        let mut h = HeaderMap::new();
        if let Some(b) = bearer {
            h.insert(AUTHORIZATION, format!("Bearer {b}").parse().unwrap());
        }
        h
    }

    #[test]
    fn rejects_when_token_unset() {
        let st = state(None);
        assert!(matches!(
            require_prover_token(&headers(Some("x")), &st),
            Err(AppError::Unauthorized(_))
        ));
    }

    #[test]
    fn rejects_missing_and_wrong_bearer() {
        let st = state(Some("secret"));
        assert!(matches!(
            require_prover_token(&headers(None), &st),
            Err(AppError::Unauthorized(_))
        ));
        assert!(matches!(
            require_prover_token(&headers(Some("nope")), &st),
            Err(AppError::Unauthorized(_))
        ));
    }

    #[test]
    fn accepts_matching_bearer() {
        let st = state(Some("secret"));
        assert!(require_prover_token(&headers(Some("secret")), &st).is_ok());
    }
}
