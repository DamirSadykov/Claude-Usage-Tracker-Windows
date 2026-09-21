use std::path::PathBuf;

use tauri::{AppHandle, Manager};

/// Resolve the Claude config directory: `CLAUDE_CONFIG_DIR` if set, else
/// `~/.claude` (via USERPROFILE on Windows, HOME elsewhere).
pub fn claude_dir() -> Option<PathBuf> {
    if let Ok(d) = std::env::var("CLAUDE_CONFIG_DIR") {
        if !d.trim().is_empty() {
            return Some(PathBuf::from(d));
        }
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    Some(PathBuf::from(home).join(".claude"))
}

/// Absolute path to the unified `cli.mjs`, forward-slashed for a clean
/// settings.json command on Windows.
pub fn cc_hook_script_path(app: &AppHandle) -> Result<String, String> {
    let resource = app
        .path()
        .resolve("scripts/cli.mjs", tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|p| p.exists());
    let dev = {
        let d = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("scripts")
            .join("cli.mjs");
        std::fs::canonicalize(&d).ok().filter(|p| p.exists())
    };
    let chosen = if cfg!(debug_assertions) {
        dev.or(resource)
    } else {
        resource.or(dev)
    };
    let p = chosen.ok_or_else(|| "cli.mjs not found (resource or dev path)".to_string())?;
    let s = p.to_string_lossy().replace('\\', "/");
    Ok(s.strip_prefix("//?/").map(str::to_string).unwrap_or(s))
}
