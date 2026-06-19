mod config;
mod db;
mod deploy;
mod error;
mod handlers;
mod indexer;
mod models;
mod stellar;

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
    tracing::info!(?config, "starting mosaic-backend");

    let db = Db::open(&config.db_path)?;
    let stellar = Stellar::new(&config);
    let bind = config.bind.clone();
    let state = Arc::new(AppState {
        config,
        db,
        stellar,
    });

    let app = Router::new()
        .route("/health", get(handlers::health))
        .route("/desks", get(handlers::list_desks).post(handlers::create_desk))
        .route("/desks/import", post(handlers::import_desk))
        .route("/desks/:id", get(handlers::get_desk))
        .route("/desks/:id/root", get(handlers::get_root))
        .route("/desks/:id/book", get(handlers::get_book))
        .route("/desks/:id/notes", get(handlers::get_notes))
        .route("/desks/:id/note-proof", get(handlers::get_note_proof))
        .route("/desks/:id/relay/order", post(handlers::relay_order))
        .route("/desks/:id/relay/unshield", post(handlers::relay_unshield))
        .route("/desks/:id/relay/cancel", post(handlers::relay_cancel))
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("listening on http://{bind}");
    axum::serve(listener, app).await?;
    Ok(())
}
