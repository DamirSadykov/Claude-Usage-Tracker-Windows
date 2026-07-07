//! Binary entrypoint: load config from the environment, load the store, serve.
//! All handler logic lives in the library (`lib.rs` + its modules).

use std::sync::{Arc, Mutex};

use resolver::config::Config;
use resolver::model::Store;
use resolver::{app, AppState};

#[tokio::main]
async fn main() {
    let config = Config::from_env().unwrap_or_else(|e| {
        eprintln!("config error: {e}");
        std::process::exit(1);
    });
    let store = Store::load(&config.store_path).unwrap_or_else(|e| {
        eprintln!("failed to load store {:?}: {e}", config.store_path);
        std::process::exit(1);
    });

    let bind = config.bind.clone();
    let mut sources: Vec<String> = config.tokens.keys().cloned().collect();
    sources.sort();
    let state = Arc::new(AppState {
        config,
        store: Mutex::new(store),
    });

    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .unwrap_or_else(|e| {
            eprintln!("failed to bind {bind}: {e}");
            std::process::exit(1);
        });

    println!("resolver listening on {bind}; ingest sources: {sources:?}");
    axum::serve(listener, app(state)).await.expect("server error");
}
