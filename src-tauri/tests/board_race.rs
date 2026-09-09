#![cfg(windows)]

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use claude_usage_tracker_lib::board_lock;
use claude_usage_tracker_lib::todos;

fn node_available() -> bool {
    Command::new("node")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn cli_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/cli.mjs")
}

struct TempBoardDir(PathBuf);

impl TempBoardDir {
    fn new(tag: &str) -> Self {
        let pid = std::process::id();
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = env::temp_dir().join(format!("board_race_{tag}_{pid}_{nanos}"));
        fs::create_dir_all(dir.join("com.claude-usage-tracker.app")).unwrap();
        TempBoardDir(dir)
    }

    fn appdata(&self) -> &Path {
        &self.0
    }

    fn board_path(&self) -> PathBuf {
        self.0.join("com.claude-usage-tracker.app").join("todos.json")
    }
}

impl Drop for TempBoardDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn add_via_cli(appdata: &Path, subject: &str) -> u32 {
    let out = Command::new("node")
        .arg(cli_path())
        .args(["todos", "add", subject, "--global"])
        .env("APPDATA", appdata)
        .output()
        .expect("spawn node add");
    assert!(
        out.status.success(),
        "add failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    let hash = stdout.find('#').expect("no # in add output");
    let rest = &stdout[hash + 1..];
    let end = rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len());
    rest[..end].parse().expect("number parse")
}

fn assert_board_dir_clean(board_path: &Path) {
    for entry in fs::read_dir(board_path.parent().unwrap()).unwrap().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == "todos.json" {
            continue;
        }
        assert!(!name.ends_with(".lock"), "leftover lock file: {name}");
        assert!(!name.contains(".stale-"), "leftover stale file: {name}");
        assert!(!name.ends_with(".tmp"), "leftover tmp file: {name}");
    }
}

#[test]
fn cli_writers_and_rust_writer_share_the_board_without_losing_a_transition() {
    if !node_available() {
        eprintln!("skip: node not found in PATH");
        return;
    }

    let board = TempBoardDir::new("wave");
    let appdata = board.appdata().to_path_buf();
    let board_path = board.board_path();

    let mut numbers = Vec::new();
    for i in 0..12 {
        numbers.push(add_via_cli(&appdata, &format!("race node {i}")));
    }
    let (cli_half, rust_half) = numbers.split_at(6);

    let children: Vec<Child> = cli_half
        .iter()
        .map(|n| {
            Command::new("node")
                .arg(cli_path())
                .args(["todos", "set", "status", &n.to_string(), "in_progress"])
                .env("APPDATA", &appdata)
                .env("BOARD_LOCK_WAIT_MS", "30000")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("spawn node set")
        })
        .collect();

    let rust_half = rust_half.to_vec();
    let writer_path = board_path.clone();
    let writer = std::thread::spawn(move || {
        let _lock = board_lock::acquire(&writer_path).expect("rust acquire");
        let mut file = todos::load(&writer_path);
        todos::ensure_numbers(&mut file);
        let now = chrono::Utc::now().to_rfc3339();
        for n in &rust_half {
            let id = file
                .todos
                .iter()
                .find(|t| t.number == *n)
                .expect("task not found")
                .id
                .clone();
            assert!(todos::set_status(&mut file, &id, "in_progress", &now));
        }
        todos::save(&writer_path, &file).expect("rust save");
    });
    writer.join().expect("writer thread panicked");

    for child in children {
        let out = child.wait_with_output().expect("wait cli child");
        assert!(
            out.status.success(),
            "cli set failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    let final_file = todos::load(&board_path);
    for n in &numbers {
        let t = final_file
            .todos
            .iter()
            .find(|t| t.number == *n)
            .unwrap_or_else(|| panic!("task #{n} missing from final board"));
        assert_eq!(t.status, "in_progress", "task #{n} lost its transition");
        assert!(
            t.status_history.iter().any(|h| h.status == "in_progress"),
            "task #{n} missing in_progress in status_history"
        );
    }

    let raw = fs::read_to_string(&board_path).unwrap();
    let _: serde_json::Value = serde_json::from_str(&raw).expect("board is valid JSON");
    assert_board_dir_clean(&board_path);
}

#[test]
fn cli_writer_waits_out_a_two_second_rust_hold_without_writing_past_it() {
    if !node_available() {
        eprintln!("skip: node not found in PATH");
        return;
    }

    let board = TempBoardDir::new("hold");
    let appdata = board.appdata().to_path_buf();
    let board_path = board.board_path();
    let n = add_via_cli(&appdata, "held by rust");

    let hold_path = board_path.clone();
    let hold_thread = std::thread::spawn(move || {
        let _lock = board_lock::acquire(&hold_path).expect("rust acquire");
        std::thread::sleep(Duration::from_secs(2));
    });

    std::thread::sleep(Duration::from_millis(300));

    let before = fs::read_to_string(&board_path).unwrap();
    let before_mtime = fs::metadata(&board_path).unwrap().modified().unwrap();

    let child = Command::new("node")
        .arg(cli_path())
        .args(["todos", "set", "status", &n.to_string(), "in_progress"])
        .env("APPDATA", &appdata)
        .env("BOARD_LOCK_WAIT_MS", "30000")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn node set");

    std::thread::sleep(Duration::from_millis(900));
    assert_eq!(
        fs::read_to_string(&board_path).unwrap(),
        before,
        "cli must not write past a live rust hold"
    );
    assert_eq!(
        fs::metadata(&board_path).unwrap().modified().unwrap(),
        before_mtime
    );

    hold_thread.join().expect("hold thread panicked");
    let out = child.wait_with_output().expect("wait cli child");
    assert!(
        out.status.success(),
        "cli set failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    let final_file = todos::load(&board_path);
    let t = final_file.todos.iter().find(|t| t.number == n).unwrap();
    assert_eq!(t.status, "in_progress");
    assert_board_dir_clean(&board_path);
}
