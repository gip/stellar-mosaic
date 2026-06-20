use crate::error::{AppError, AppResult};
use crate::models::{CreateDesk, Desk, ImportDesk};
use crate::AppState;
use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;

pub async fn health() -> Json<Value> {
    // Debug, not info: health is polled frequently and would otherwise flood the logs.
    tracing::debug!("health check");
    Json(json!({ "ok": true }))
}

pub async fn list_desks(State(st): State<Arc<AppState>>) -> AppResult<Json<Vec<Desk>>> {
    tracing::info!("list_desks");
    let desks = st.db.list_desks()?;
    tracing::info!(count = desks.len(), "list_desks ok");
    Ok(Json(desks))
}

pub async fn get_desk(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> AppResult<Json<Desk>> {
    tracing::info!(desk = %id, "get_desk");
    Ok(Json(st.db.get_desk(&id)?))
}

/// Import an already-deployed contract as a read-only desk (Phase 1 convenience).
pub async fn import_desk(
    State(st): State<Arc<AppState>>,
    Json(body): Json<ImportDesk>,
) -> AppResult<Json<Desk>> {
    tracing::info!(name = %body.name, contract_id = %body.contract_id, "import_desk");
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
    st.db.insert_desk(&desk, None, None)?;
    tracing::info!(desk = %desk.id, contract_id = %desk.contract_id, "import_desk ok");
    Ok(Json(desk))
}

/// Create a new desk: deploy a fresh settlement contract + sponsor account, register assets/pairs.
/// The deploy pipeline makes several blocking testnet calls, so it runs on a blocking thread.
pub async fn create_desk(
    State(st): State<Arc<AppState>>,
    Json(body): Json<CreateDesk>,
) -> AppResult<Json<Desk>> {
    tracing::info!(name = %body.name, assets = body.assets.len(), pairs = body.pairs.len(), "create_desk");
    let desk = tokio::task::spawn_blocking(move || crate::deploy::create_desk(&st, body))
        .await
        .map_err(|e| AppError::Other(anyhow::anyhow!(e)))??;
    tracing::info!(desk = %desk.id, contract_id = %desk.contract_id, "create_desk ok");
    Ok(Json(desk))
}

pub async fn get_root(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    tracing::info!(desk = %id, "get_root");
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
    tracing::info!(desk = %id, pair = q.pair, side = q.side, "get_book");
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

// ---- note discovery + membership paths (indexer) ----

pub async fn get_notes(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    tracing::info!(desk = %id, "get_notes");
    let desk = st.db.get_desk(&id)?;
    let from = st.db.from_ledger(&id)?;
    let notes = tokio::task::spawn_blocking(move || {
        crate::indexer::notes(&st.stellar, &desk.contract_id, from)
    })
    .await
    .map_err(|e| AppError::Other(anyhow::anyhow!(e)))??;
    Ok(Json(json!({ "notes": notes })))
}

#[derive(Deserialize)]
pub struct ProofQuery {
    pub owner_tag: String,
}

pub async fn get_note_proof(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<ProofQuery>,
) -> AppResult<Json<Value>> {
    tracing::info!(desk = %id, owner_tag = %q.owner_tag, "get_note_proof");
    let desk = st.db.get_desk(&id)?;
    let from = st.db.from_ledger(&id)?;
    let proof = tokio::task::spawn_blocking(move || {
        crate::indexer::note_proof(&st.stellar, &desk.contract_id, from, &q.owner_tag)
    })
    .await
    .map_err(|e| AppError::Other(anyhow::anyhow!(e)))??;
    Ok(Json(serde_json::to_value(proof).unwrap()))
}

// ---- sponsored shield: frontend builds + user-signs the auth entry; sponsor signs envelope ----

#[derive(Deserialize)]
pub struct ShieldSubmit {
    /// Frontend-built transaction XDR: source = sponsor, op auth = user-signed entry, unsigned envelope.
    pub tx_xdr: String,
}

pub async fn shield_submit(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<ShieldSubmit>,
) -> AppResult<Json<Value>> {
    tracing::info!(desk = %id, xdr_len = body.tx_xdr.len(), "shield_submit: sponsor signing + sending");
    let secret = st
        .db
        .sponsor_secret(&id)?
        .ok_or_else(|| AppError::BadRequest("desk has no sponsor key (imported, read-only)".into()))?;
    let tx_xdr = body.tx_xdr;
    let out = tokio::task::spawn_blocking(move || st.stellar.sign_and_send(&tx_xdr, &secret))
        .await
        .map_err(|e| AppError::Other(anyhow::anyhow!(e)))??;
    tracing::info!(desk = %id, result = %out, "shield_submit ok");
    Ok(Json(json!({ "ok": true, "result": out })))
}

// ---- fully-sponsored relays (no user signature; the ZK proof is the spend authority) ----

#[derive(Deserialize)]
pub struct RelayOrder {
    pub proof_b64: String,
    pub public_inputs_b64: String,
}

pub async fn relay_order(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<RelayOrder>,
) -> AppResult<Json<Value>> {
    relay(st, id, "relay_order", body.proof_b64, body.public_inputs_b64, |proof, pi| {
        vec![
            "submit_order".into(),
            "--proof-file-path".into(),
            proof,
            "--public_inputs-file-path".into(),
            pi,
        ]
    })
    .await
}

pub async fn relay_join(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<RelayOrder>,
) -> AppResult<Json<Value>> {
    relay(st, id, "relay_join", body.proof_b64, body.public_inputs_b64, |proof, pi| {
        vec![
            "join".into(),
            "--proof-file-path".into(),
            proof,
            "--public_inputs-file-path".into(),
            pi,
        ]
    })
    .await
}

#[derive(Deserialize)]
pub struct RelayUnshield {
    pub to: String,
    pub proof_b64: String,
    pub public_inputs_b64: String,
}

pub async fn relay_unshield(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<RelayUnshield>,
) -> AppResult<Json<Value>> {
    let to = body.to;
    relay(st, id, "relay_unshield", body.proof_b64, body.public_inputs_b64, move |proof, pi| {
        vec![
            "unshield".into(),
            "--to".into(),
            to,
            "--proof_bytes-file-path".into(),
            proof,
            "--public_inputs-file-path".into(),
            pi,
        ]
    })
    .await
}

#[derive(Deserialize)]
pub struct RelayCancel {
    pub pair_id: u32,
    pub side: u32,
    pub proof_b64: String,
    pub public_inputs_b64: String,
}

pub async fn relay_cancel(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<RelayCancel>,
) -> AppResult<Json<Value>> {
    let (pair, side) = (body.pair_id, body.side);
    relay(st, id, "relay_cancel", body.proof_b64, body.public_inputs_b64, move |proof, pi| {
        vec![
            "cancel_order".into(),
            "--pair_id".into(),
            pair.to_string(),
            "--side".into(),
            side.to_string(),
            "--proof-file-path".into(),
            proof,
            "--public_inputs-file-path".into(),
            pi,
        ]
    })
    .await
}

/// Shared relay: decode proof + public inputs, write temp files, submit the call signed by the
/// desk's sponsor (fully sponsored), and clean up.
async fn relay(
    st: Arc<AppState>,
    desk_id: String,
    action: &'static str,
    proof_b64: String,
    pi_b64: String,
    build_args: impl FnOnce(String, String) -> Vec<String> + Send + 'static,
) -> AppResult<Json<Value>> {
    use base64::Engine;
    tracing::info!(desk = %desk_id, proof_len = proof_b64.len(), "{action}: fully-sponsored relay");
    let secret = st
        .db
        .sponsor_secret(&desk_id)?
        .ok_or_else(|| AppError::BadRequest("desk has no sponsor key (imported, read-only)".into()))?;
    let desk = st.db.get_desk(&desk_id)?;
    let b64 = base64::engine::general_purpose::STANDARD;
    let proof = b64
        .decode(proof_b64.trim())
        .map_err(|e| AppError::BadRequest(format!("proof_b64: {e}")))?;
    let pi = b64
        .decode(pi_b64.trim())
        .map_err(|e| AppError::BadRequest(format!("public_inputs_b64: {e}")))?;

    let out = tokio::task::spawn_blocking(move || -> AppResult<String> {
        let dir = std::env::temp_dir();
        let stem = Uuid::new_v4().to_string();
        let proof_path = dir.join(format!("{stem}.proof"));
        let pi_path = dir.join(format!("{stem}.pi"));
        std::fs::write(&proof_path, &proof).map_err(|e| AppError::Other(e.into()))?;
        std::fs::write(&pi_path, &pi).map_err(|e| AppError::Other(e.into()))?;
        let args = build_args(
            proof_path.to_string_lossy().into(),
            pi_path.to_string_lossy().into(),
        );
        let res = st.stellar.invoke_write(&desk.contract_id, &secret, &args);
        let _ = std::fs::remove_file(&proof_path);
        let _ = std::fs::remove_file(&pi_path);
        res
    })
    .await
    .map_err(|e| AppError::Other(anyhow::anyhow!(e)))??;

    tracing::info!(desk = %desk_id, result = %out, "{action} ok");
    Ok(Json(json!({ "ok": true, "result": out })))
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
