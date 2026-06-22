mod auth;
mod base_shield;
mod config;
mod db;
mod deploy;
mod durable_indexer;
mod error;
mod handlers;
mod indexer;
mod models;
mod operations;
mod stellar;

use axum::extract::DefaultBodyLimit;
use axum::routing::{get, post};
use axum::Router;
use config::Config;
use db::Db;
use std::sync::Arc;
use stellar::Stellar;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

pub struct AppState {
    pub config: Config,
    pub db: Db,
    pub stellar: Stellar,
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
    tracing::info!(bind=%config.bind, network=%config.network, database=%if config.database_url.starts_with("postgres") {"postgres"} else {"sqlite"}, "starting mosaic-backend");

    let db = Db::open(&config.database_url).await?;
    let stellar = Stellar::new(&config);
    let bind = config.bind.clone();
    let state = Arc::new(AppState {
        config,
        db,
        stellar,
    });

    let worker_state = state.clone();
    tokio::spawn(async move {
        loop {
            if let Err(error) = worker_state.db.promote_queued().await {
                tracing::error!(%error, "operation queue promotion failed");
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
    });
    tokio::spawn(durable_indexer::run(state.clone()));
    // Base->Stellar shield worker (WS6): only runs when a Base RPC is configured.
    if state.config.base_rpc.is_some() {
        tokio::spawn(base_shield::run(state.clone()));
    } else {
        tracing::info!("base-shield worker disabled (set MOSAIC_BASE_RPC to enable)");
    }

    let app = Router::new()
        .route("/health", get(handlers::health))
        .merge(auth::routes())
        .merge(operations::routes())
        .route(
            "/desks",
            get(handlers::list_desks).post(handlers::create_desk),
        )
        .route("/desks/import", post(handlers::import_desk))
        .route("/desks/:id", get(handlers::get_desk))
        .route("/desks/:id/root", get(handlers::get_root))
        .route("/desks/:id/book", get(handlers::get_book))
        .route("/desks/:id/notes", get(handlers::get_notes))
        .route("/desks/:id/fills", get(handlers::get_fills))
        .route("/desks/:id/note-proof", get(handlers::get_note_proof))
        .route(
            "/desks/:id/base-shields",
            get(handlers::list_base_shields).post(handlers::enqueue_base_shield),
        )
        .route(
            "/client-actions/relay/desks/:id/shield",
            post(handlers::shield_submit),
        )
        .route(
            "/client-actions/relay/desks/:id/order",
            post(handlers::relay_order),
        )
        .route(
            "/client-actions/relay/desks/:id/join",
            post(handlers::relay_join),
        )
        .route(
            "/client-actions/relay/desks/:id/unshield",
            post(handlers::relay_unshield),
        )
        .route(
            "/client-actions/relay/desks/:id/cancel",
            post(handlers::relay_cancel),
        )
        .route(
            "/wallet-backups/:backup_id",
            get(handlers::get_wallet_backup).put(handlers::put_wallet_backup),
        )
        // Base64 expands the 2 MiB decoded ciphertext; handlers enforce the decoded limit.
        .layer(DefaultBodyLimit::max(3 * 1024 * 1024))
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("listening on http://{bind}");
    axum::serve(listener, app).await?;
    Ok(())
}
