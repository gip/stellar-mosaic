use crate::auth::{require_session, Session};
use crate::db::{ClientAction, Operation};
use crate::error::{AppError, AppResult};
use crate::AppState;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::Stream;
use serde::Deserialize;
use serde_json::{json, Value};
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/operations", get(list).post(create))
        .route("/operations/events", get(events))
        .route("/operations/:id", get(get_operation))
        .route("/operations/:id/cancel", post(cancel))
        .route("/client-actions/next", post(claim_action))
        .route("/client-actions/:id/heartbeat", post(heartbeat_action))
        .route("/client-actions/:id/complete", post(complete_action))
        .route("/client-actions/:id/fail", post(fail_action))
}

async fn create(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> AppResult<(StatusCode, Json<Operation>)> {
    let session = require_session(&headers, &st).await?;
    let kind = body
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::BadRequest("operation kind required".into()))?;
    if !matches!(
        kind,
        "shield" | "place_order" | "unshield" | "cancel_order" | "match"
    ) {
        return Err(AppError::BadRequest("unsupported operation kind".into()));
    }
    let desk_id = body
        .get("desk_id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::BadRequest("desk_id required".into()))?;
    st.db.get_desk(desk_id).await?;
    validate_request(kind, &body)?;
    let key = headers
        .get("idempotency-key")
        .and_then(|h| h.to_str().ok())
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let operation = st
        .db
        .enqueue_operation(
            &session.address,
            &session.network,
            desk_id,
            kind,
            &body,
            &key,
        )
        .await?;
    Ok((StatusCode::ACCEPTED, Json(operation)))
}

fn validate_request(kind: &str, v: &Value) -> AppResult<()> {
    let positive = |name: &str| -> AppResult<()> {
        let s = v
            .get(name)
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::BadRequest(format!("{name} required")))?;
        if s.parse::<u128>().unwrap_or(0) == 0 {
            return Err(AppError::BadRequest(format!("{name} must be positive")));
        }
        Ok(())
    };
    match kind {
        "shield" => {
            v.get("asset_id")
                .and_then(Value::as_u64)
                .ok_or_else(|| AppError::BadRequest("asset_id required".into()))?;
            positive("amount")?;
        }
        "place_order" => {
            v.get("pair_id")
                .and_then(Value::as_u64)
                .ok_or_else(|| AppError::BadRequest("pair_id required".into()))?;
            if !matches!(v.get("side").and_then(Value::as_str), Some("BUY" | "SELL")) {
                return Err(AppError::BadRequest("side must be BUY or SELL".into()));
            }
            positive("amount_in")?;
            positive("min_out")?;
        }
        "unshield" => {
            v.get("asset_id")
                .and_then(Value::as_u64)
                .ok_or_else(|| AppError::BadRequest("asset_id required".into()))?;
            positive("amount")?;
            v.get("recipient")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::BadRequest("recipient required".into()))?;
        }
        "cancel_order" => {
            v.get("wallet_note_id")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::BadRequest("wallet_note_id required".into()))?;
        }
        _ => {}
    }
    Ok(())
}

async fn list(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<Vec<Operation>>> {
    let s = require_session(&headers, &st).await?;
    Ok(Json(st.db.list_operations(&s.address).await?))
}
async fn get_operation(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Json<Operation>> {
    let s = require_session(&headers, &st).await?;
    Ok(Json(st.db.get_operation(&s.address, &id).await?))
}
async fn cancel(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Json<Operation>> {
    let s = require_session(&headers, &st).await?;
    Ok(Json(st.db.cancel_operation(&s.address, &id).await?))
}

async fn claim_action(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    let s = require_session(&headers, &st).await?;
    let action: Option<ClientAction> = st.db.claim_action(&s.address).await?;
    Ok(Json(json!({"action":action})))
}

#[derive(Deserialize)]
struct LeaseBody {
    lease_token: String,
}
async fn heartbeat_action(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<LeaseBody>,
) -> AppResult<Json<Value>> {
    let s = require_session(&headers, &st).await?;
    let expires_at = st
        .db
        .heartbeat_action(&s.address, &id, &body.lease_token)
        .await?;
    Ok(Json(json!({"lease_expires_at":expires_at})))
}

#[derive(Deserialize)]
struct CompleteBody {
    lease_token: String,
    #[serde(default)]
    result: Value,
}
async fn complete_action(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<CompleteBody>,
) -> AppResult<Json<Operation>> {
    let s = require_session(&headers, &st).await?;
    Ok(Json(
        st.db
            .complete_action(&s.address, &id, &body.lease_token, &body.result)
            .await?,
    ))
}

#[derive(Deserialize)]
struct FailBody {
    lease_token: String,
    error: String,
    #[serde(default)]
    retryable: bool,
}
async fn fail_action(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<FailBody>,
) -> AppResult<Json<Operation>> {
    let s = require_session(&headers, &st).await?;
    Ok(Json(
        st.db
            .fail_action(
                &s.address,
                &id,
                &body.lease_token,
                &body.error,
                body.retryable,
            )
            .await?,
    ))
}

async fn events(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    let s = require_session(&headers, &st).await?;
    let mut cursor = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0_i64);
    let db = st.db.clone();
    let address = s.address;
    let stream = async_stream::stream! {
        loop {
            match db.events_after(&address,cursor).await {
                Ok(items)=>for item in items {cursor=item.cursor;yield Ok(Event::default().id(item.cursor.to_string()).event("operation").json_data(&item).unwrap());},
                Err(error)=>yield Ok(Event::default().event("error").data(error.to_string())),
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    };
    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keepalive"),
    ))
}

/// Require both a wallet session and a currently leased client action. All mutation relay routes
/// call this, so legacy direct callers cannot bypass the durable per-wallet queue.
pub async fn authorize_mutation(
    headers: &HeaderMap,
    st: &AppState,
) -> AppResult<(Session, String, String)> {
    let session = require_session(headers, st).await?;
    let action_id = headers
        .get("x-mosaic-action-id")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::Unauthorized("client action id required".into()))?;
    let lease = headers
        .get("x-mosaic-action-lease")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::Unauthorized("client action lease required".into()))?;
    let operation_id = st
        .db
        .validate_action_lease(&session.address, action_id, lease)
        .await?;
    Ok((session, operation_id, action_id.to_string()))
}
