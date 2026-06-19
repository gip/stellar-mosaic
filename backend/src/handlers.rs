use crate::error::{AppError, AppResult};
use crate::models::{Desk, ImportDesk};
use crate::AppState;
use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;

pub async fn health() -> Json<Value> {
    Json(json!({ "ok": true }))
}

pub async fn list_desks(State(st): State<Arc<AppState>>) -> AppResult<Json<Vec<Desk>>> {
    Ok(Json(st.db.list_desks()?))
}

pub async fn get_desk(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> AppResult<Json<Desk>> {
    Ok(Json(st.db.get_desk(&id)?))
}

/// Import an already-deployed contract as a read-only desk (Phase 1 convenience).
pub async fn import_desk(
    State(st): State<Arc<AppState>>,
    Json(body): Json<ImportDesk>,
) -> AppResult<Json<Desk>> {
    if body.contract_id.trim().is_empty() {
        return Err(AppError::BadRequest("contract_id required".into()));
    }
    let desk = Desk {
        id: Uuid::new_v4().to_string(),
        name: body.name,
        contract_id: body.contract_id,
        sponsor_pubkey: body.sponsor_pubkey,
        assets: body.assets,
        pairs: body.pairs,
    };
    st.db.insert_desk(&desk, None)?;
    Ok(Json(desk))
}

pub async fn get_root(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let desk = st.db.get_desk(&id)?;
    let root = st
        .stellar
        .root(&desk.contract_id, &read_source(&desk, &st))?;
    Ok(Json(json!({ "root": root })))
}

#[derive(Deserialize)]
pub struct BookQuery {
    pub pair: u32,
    pub side: u32,
}

pub async fn get_book(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<BookQuery>,
) -> AppResult<Json<Value>> {
    let desk = st.db.get_desk(&id)?;
    let book = st
        .stellar
        .book(&desk.contract_id, &read_source(&desk, &st), q.pair, q.side)?;
    Ok(Json(json!({
        "pair": q.pair,
        "side": q.side,
        "orders": book,
    })))
}

/// Source account for read-only simulations: the desk's sponsor, falling back to the configured
/// read identity for imported desks whose sponsor key isn't in the local keystore.
fn read_source(desk: &Desk, st: &AppState) -> String {
    if desk.sponsor_pubkey.starts_with('G') {
        desk.sponsor_pubkey.clone()
    } else {
        st.config.read_identity.clone()
    }
}
