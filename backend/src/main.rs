//! Mosaic prove service — an async submit/poll HTTP wrapper around the `bridge-prover`.
//!
//! Scope is deliberately tiny: prove a Base deposit (STARK -> Groth16) and serve the artifacts. All
//! desk/relayer/indexer orchestration and the Base->Stellar shield lifecycle now live in the MCP
//! server (`packages/mcp`), which drives this service over HTTP and owns finality + `shield_from_base`.

mod config;
mod error;
mod prove;
mod prove_manager;
mod prover;

use axum::routing::{get, post};
use axum::{Json, Router};
use config::Config;
use prove_manager::ProveManager;
use serde_json::{json, Value};
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

pub struct AppState {
    pub config: Config,
    pub prover: ProveManager,
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok", "service": "mosaic-prove" }))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "mosaic_backend=info,tower_http=info".into()),
        )
        .init();

    let config = Config::from_env();
    if config.base_rpc.is_none() {
        tracing::warn!("MOSAIC_BASE_RPC is unset; prove requests will be rejected until it is set");
    }
    if config.prover_token.is_none() {
        tracing::warn!("MOSAIC_PROVER_TOKEN is unset; prove requests will be rejected until it is set");
    }
    tracing::info!(bind = %config.bind, prover_dir = %config.prover_dir.display(), "starting mosaic prove service");

    let bind = config.bind.clone();
    let state = Arc::new(AppState {
        prover: ProveManager::new(config.clone()),
        config,
    });

    let app = Router::new()
        .route("/health", get(health))
        .route("/prove/base-deposit", post(prove::submit_prove))
        .route("/prove/base-deposit/:job_id", get(prove::get_prove))
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("listening on http://{bind}");
    axum::serve(listener, app).await?;
    Ok(())
}
