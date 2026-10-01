use std::path::{Path, PathBuf};
use std::process::Command;

fn resolve_node() -> PathBuf {
    let mut cmd = Command::new("where");
    cmd.arg("node");
    no_window(&mut cmd);
    if let Ok(out) = cmd.output() {
        if out.status.success() {
            if let Some(first) = String::from_utf8_lossy(&out.stdout).lines().next() {
                let path = first.trim();
                if !path.is_empty() {
                    return PathBuf::from(path);
                }
            }
        }
    }
    PathBuf::from("node")
}

fn run_node(node: &Path, cli_path: &str, args: &[&str]) -> Result<std::process::Output, String> {
    let mut cmd = Command::new(node);
    cmd.arg(cli_path).args(args);
    no_window(&mut cmd);
    cmd.output()
        .map_err(|e| format!("failed to run node {cli_path}: {e}"))
}

pub fn run_corrections_publish(cli_path: &str) -> Result<(), String> {
    let node = resolve_node();
    let out = run_node(&node, cli_path, &["corrections", "publish", "--all"])?;
    if !out.status.success() {
        return Err(format!(
            "corrections publish failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

pub fn run_task_cost_publish(cli_path: &str) -> Result<(), String> {
    let node = resolve_node();
    let out = run_node(&node, cli_path, &["task-cost", "publish", "--all"])?;
    if !out.status.success() {
        return Err(format!(
            "task-cost publish failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn no_window(_cmd: &mut Command) {}
