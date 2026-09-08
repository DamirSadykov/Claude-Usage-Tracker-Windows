use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::thread::ThreadId;
use std::time::{Duration, Instant};

use chrono::SecondsFormat;
use serde_json::Value;

const POLL_INTERVAL: Duration = Duration::from_millis(25);
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);
const STALE_AGE: Duration = Duration::from_secs(600);
const STALE_MTIME_AGE: Duration = Duration::from_secs(30);

#[derive(Debug)]
pub enum LockError {
    Busy {
        pid: u32,
        writer: String,
        at: String,
        path: PathBuf,
    },
    Unreadable {
        path: PathBuf,
    },
    Io(std::io::Error),
}

impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LockError::Busy { pid, writer, at, path } => write!(
                f,
                "board locked by pid {pid} ({writer}, since {at}): {}",
                path.display()
            ),
            LockError::Unreadable { path } => {
                write!(f, "board locked (contents unreadable): {}", path.display())
            }
            LockError::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for LockError {}

impl From<std::io::Error> for LockError {
    fn from(e: std::io::Error) -> Self {
        LockError::Io(e)
    }
}

#[derive(Debug)]
pub struct BoardLock {
    key: String,
    lock_path: PathBuf,
}

fn registry() -> &'static Mutex<HashMap<String, (ThreadId, usize)>> {
    static REG: OnceLock<Mutex<HashMap<String, (ThreadId, usize)>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

fn normalize_key(board: &Path) -> String {
    let parent = board.parent().unwrap_or_else(|| Path::new("."));
    let canon_parent = std::fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
    let file_name = board.file_name().map(|f| f.to_os_string()).unwrap_or_default();
    let combined = canon_parent.join(file_name);
    let s = combined.to_string_lossy().into_owned();
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

fn lock_path_for(board: &Path) -> PathBuf {
    let mut name = board.file_name().map(|f| f.to_os_string()).unwrap_or_default();
    name.push(".lock");
    board.with_file_name(name)
}

struct LockHolder {
    pid: u32,
    writer: String,
    at: String,
}

fn valid_pid(value: &Value) -> Option<u32> {
    if let Some(n) = value.as_i64() {
        return (n > 0 && n <= u32::MAX as i64).then_some(n as u32);
    }
    if let Some(f) = value.as_f64() {
        if f > 0.0 && f.fract() == 0.0 && f <= u32::MAX as f64 {
            return Some(f as u32);
        }
    }
    None
}

fn parse_holder(content: &str) -> Option<LockHolder> {
    let value: Value = serde_json::from_str(content).ok()?;
    let pid = valid_pid(value.get("pid")?)?;
    let at = value.get("at")?.as_str()?.to_string();
    let writer = value
        .get("writer")
        .and_then(|w| w.as_str())
        .unwrap_or_default()
        .to_string();
    Some(LockHolder { pid, writer, at })
}

fn age_from_at(at: &str) -> Option<Duration> {
    let dt = chrono::DateTime::parse_from_rfc3339(at).ok()?;
    let now = chrono::Utc::now();
    Some(
        now.signed_duration_since(dt.with_timezone(&chrono::Utc))
            .to_std()
            .unwrap_or(Duration::from_secs(0)),
    )
}

pub(crate) fn is_stale(content: &str, mtime_age: Duration, pid_alive: impl Fn(u32) -> bool) -> bool {
    let Some(holder) = parse_holder(content) else {
        return mtime_age > STALE_MTIME_AGE;
    };
    if !pid_alive(holder.pid) {
        return true;
    }
    match age_from_at(&holder.at) {
        Some(age) => age > STALE_AGE,
        None => mtime_age > STALE_MTIME_AGE,
    }
}

fn mtime_age(path: &Path) -> Duration {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .unwrap_or(Duration::from_secs(0))
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_INVALID_PARAMETER, ERROR_NOT_FOUND, FALSE, STILL_ACTIVE,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if handle.is_null() {
            let err = windows_sys::Win32::Foundation::GetLastError();
            return !(err == ERROR_INVALID_PARAMETER || err == ERROR_NOT_FOUND);
        }
        let mut exit_code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut exit_code);
        CloseHandle(handle);
        if ok == FALSE {
            return true;
        }
        exit_code == STILL_ACTIVE as u32
    }
}

#[cfg(not(windows))]
fn pid_alive(_pid: u32) -> bool {
    true
}

fn write_lock_file(lock_path: &Path, pid: u32) -> std::io::Result<()> {
    let content = serde_json::json!({
        "pid": pid,
        "writer": "app",
        "at": chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    })
    .to_string();
    let mut f = OpenOptions::new().write(true).create_new(true).open(lock_path)?;
    f.write_all(content.as_bytes())
}

fn remove_stale(lock_path: &Path) {
    let pid = std::process::id();
    let mut stale_name = lock_path.file_name().map(|f| f.to_os_string()).unwrap_or_default();
    stale_name.push(format!(".stale-{pid}"));
    let stale_path = lock_path.with_file_name(stale_name);
    if std::fs::rename(lock_path, &stale_path).is_ok() {
        let _ = std::fs::remove_file(&stale_path);
    }
}

fn busy_error(lock_path: &Path, content: &str) -> LockError {
    match parse_holder(content) {
        Some(h) => LockError::Busy {
            pid: h.pid,
            writer: h.writer,
            at: h.at,
            path: lock_path.to_path_buf(),
        },
        None => LockError::Unreadable { path: lock_path.to_path_buf() },
    }
}

fn sweep_orphaned_tmp(board: &Path) {
    let Some(dir) = board.parent() else { return };
    let Some(stem) = board.file_name().map(|f| f.to_string_lossy().into_owned()) else {
        return;
    };
    let prefix = format!("{stem}.");
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(mid) = name.strip_prefix(&prefix).and_then(|s| s.strip_suffix(".tmp")) {
            if !mid.is_empty() && mid.chars().all(|c| c.is_ascii_digit()) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

enum ReadOutcome {
    Missing,
    Unreadable,
    Content(String),
}

fn read_lock(lock_path: &Path) -> ReadOutcome {
    match std::fs::read_to_string(lock_path) {
        Ok(s) => ReadOutcome::Content(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => ReadOutcome::Missing,
        Err(_) => ReadOutcome::Unreadable,
    }
}

fn acquire_impl(board: &Path, timeout: Duration) -> Result<BoardLock, LockError> {
    let key = normalize_key(board);
    let lock_path = lock_path_for(board);
    let pid = std::process::id();
    let me = std::thread::current().id();
    let deadline = Instant::now() + timeout;

    loop {
        {
            let mut map = registry().lock().unwrap();
            match map.get(&key).copied() {
                Some((owner, _)) if owner == me => {
                    map.get_mut(&key).unwrap().1 += 1;
                    return Ok(BoardLock { key, lock_path });
                }
                Some(_) => {
                    drop(map);
                    if Instant::now() >= deadline {
                        let content = std::fs::read_to_string(&lock_path).unwrap_or_default();
                        return Err(busy_error(&lock_path, &content));
                    }
                    std::thread::sleep(POLL_INTERVAL);
                    continue;
                }
                None => drop(map),
            }
        }

        match write_lock_file(&lock_path, pid) {
            Ok(()) => {
                registry().lock().unwrap().insert(key.clone(), (me, 1));
                sweep_orphaned_tmp(board);
                return Ok(BoardLock { key, lock_path });
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(LockError::Io(e)),
        }

        match read_lock(&lock_path) {
            ReadOutcome::Missing => {
                if Instant::now() >= deadline {
                    return Err(busy_error(&lock_path, ""));
                }
                continue;
            }
            ReadOutcome::Unreadable => {
                if Instant::now() >= deadline {
                    return Err(LockError::Unreadable { path: lock_path.clone() });
                }
                std::thread::sleep(POLL_INTERVAL);
            }
            ReadOutcome::Content(content) => {
                let age = mtime_age(&lock_path);
                if is_stale(&content, age, pid_alive) {
                    remove_stale(&lock_path);
                    if Instant::now() >= deadline {
                        return Err(busy_error(&lock_path, &content));
                    }
                    continue;
                }
                if Instant::now() >= deadline {
                    return Err(busy_error(&lock_path, &content));
                }
                std::thread::sleep(POLL_INTERVAL);
            }
        }
    }
}

pub fn acquire_with_timeout(board: &Path, timeout: Duration) -> Result<BoardLock, LockError> {
    acquire_impl(board, timeout)
}

pub fn acquire(board: &Path) -> Result<BoardLock, LockError> {
    acquire_impl(board, DEFAULT_TIMEOUT)
}

fn release_file(lock_path: &Path) {
    let pid = std::process::id();
    let Ok(content) = std::fs::read_to_string(lock_path) else { return };
    let Some(holder) = parse_holder(&content) else { return };
    if holder.pid != pid {
        return;
    }
    let _ = std::fs::remove_file(lock_path);
}

impl Drop for BoardLock {
    fn drop(&mut self) {
        let mut map = registry().lock().unwrap();
        let done = match map.get_mut(&self.key) {
            Some((_, count)) => {
                *count -= 1;
                let zero = *count == 0;
                if zero {
                    map.remove(&self.key);
                }
                zero
            }
            None => true,
        };
        if done {
            release_file(&self.lock_path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TempBoard(PathBuf);

    impl TempBoard {
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempBoard {
        fn drop(&mut self) {
            if let Some(dir) = self.0.parent() {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }

    fn unique_board() -> TempBoard {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("board_lock_test_{pid}_{nanos}_{n}"));
        std::fs::create_dir_all(&dir).unwrap();
        TempBoard(dir.join("todos.json"))
    }

    fn node_content(pid: u32, writer: &str, at: &str) -> String {
        serde_json::json!({ "pid": pid, "writer": writer, "at": at }).to_string()
    }

    fn now_ms() -> String {
        chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
    }

    #[test]
    fn acquire_release_leaves_dir_clean() {
        let board = unique_board();
        let lock = acquire_impl(board.path(), Duration::from_millis(200)).unwrap();
        assert!(lock_path_for(board.path()).exists());
        drop(lock);
        let dir = board.path().parent().unwrap();
        let entries: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().collect();
        assert!(entries.is_empty(), "directory not clean: {:?}", entries);
    }

    #[test]
    fn busy_when_holder_is_alive() {
        let board = unique_board();
        let lock_path = lock_path_for(board.path());
        let pid = std::process::id();
        std::fs::write(&lock_path, node_content(pid, "app", &now_ms())).unwrap();

        let err = acquire_impl(board.path(), Duration::from_millis(100)).unwrap_err();
        match err {
            LockError::Busy { pid: p, .. } => assert_eq!(p, pid),
            other => panic!("expected Busy, got {other:?}"),
        }
    }

    #[cfg(windows)]
    #[test]
    fn dead_pid_lock_is_swept_and_leaves_no_stale_file() {
        let board = unique_board();
        let lock_path = lock_path_for(board.path());
        let mut child = std::process::Command::new("cmd").args(["/c", "exit"]).spawn().unwrap();
        let dead_pid = child.id();
        child.wait().unwrap();

        std::fs::write(&lock_path, node_content(dead_pid, "app", &now_ms())).unwrap();

        let lock = acquire_impl(board.path(), Duration::from_millis(500)).unwrap();
        let dir = board.path().parent().unwrap();
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            assert!(!name.contains(".stale-"), "leftover stale file: {name}");
        }
        drop(lock);
    }

    #[test]
    fn unreadable_lock_younger_than_30s_is_busy_then_unreadable_after_timeout() {
        let board = unique_board();
        let lock_path = lock_path_for(board.path());
        std::fs::write(&lock_path, b"not json").unwrap();

        let err = acquire_impl(board.path(), Duration::from_millis(100)).unwrap_err();
        match err {
            LockError::Unreadable { path } => {
                assert_eq!(path, lock_path);
                assert_eq!(
                    err_display(&LockError::Unreadable { path: lock_path.clone() }),
                    format!("board locked (contents unreadable): {}", lock_path.display())
                );
            }
            other => panic!("expected Unreadable, got {other:?}"),
        }
    }

    fn err_display(e: &LockError) -> String {
        e.to_string()
    }

    #[test]
    fn reentrant_acquire_does_not_wait_or_recreate() {
        let board = unique_board();
        let outer = acquire_impl(board.path(), Duration::from_secs(15)).unwrap();
        let created = std::fs::metadata(lock_path_for(board.path())).unwrap().modified().unwrap();

        let start = Instant::now();
        let inner = acquire_impl(board.path(), Duration::from_secs(15)).unwrap();
        assert!(start.elapsed() < Duration::from_millis(200));
        let still = std::fs::metadata(lock_path_for(board.path())).unwrap().modified().unwrap();
        assert_eq!(created, still);

        drop(inner);
        assert!(lock_path_for(board.path()).exists());
        drop(outer);
        assert!(!lock_path_for(board.path()).exists());
    }

    #[test]
    fn sweep_removes_pid_tmp_but_not_target() {
        let board = unique_board();
        let dir = board.path().parent().unwrap();
        let pid = std::process::id();
        let tmp = dir.join(format!("todos.json.{pid}.tmp"));
        std::fs::write(&tmp, b"x").unwrap();
        std::fs::write(board.path(), b"{}").unwrap();

        sweep_orphaned_tmp(board.path());

        assert!(!tmp.exists());
        assert!(board.path().exists());
    }

    #[test]
    fn is_stale_pure_function() {
        let alive_content = node_content(1234, "app", &now_ms());
        assert!(!is_stale(&alive_content, Duration::from_secs(0), |_| true));
        assert!(is_stale(&alive_content, Duration::from_secs(0), |_| false));

        let old_at = (chrono::Utc::now() - chrono::Duration::minutes(11))
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        let old_content = node_content(1234, "app", &old_at);
        assert!(is_stale(&old_content, Duration::from_secs(0), |_| true));

        // pid alive but `at` unparsable -> falls back to the mtime rule.
        let bad_at_content = serde_json::json!({ "pid": 1234, "writer": "app", "at": "not-a-date" }).to_string();
        assert!(!is_stale(&bad_at_content, Duration::from_secs(10), |_| true));
        assert!(is_stale(&bad_at_content, Duration::from_secs(31), |_| true));

        // pid not a valid positive integer -> falls back to the mtime rule.
        let bad_pid_content = serde_json::json!({ "pid": -5, "writer": "app", "at": now_ms() }).to_string();
        assert!(!is_stale(&bad_pid_content, Duration::from_secs(10), |_| true));
        assert!(is_stale(&bad_pid_content, Duration::from_secs(31), |_| true));

        assert!(!is_stale("garbage", Duration::from_secs(10), |_| true));
        assert!(is_stale("garbage", Duration::from_secs(31), |_| true));
    }

    // --- Node compatibility (t#574 review) ------------------------------------

    #[test]
    fn node_written_lock_with_live_pid_reports_busy_with_writer() {
        let board = unique_board();
        let lock_path = lock_path_for(board.path());
        let pid = std::process::id();
        std::fs::write(&lock_path, node_content(pid, "cli", &now_ms())).unwrap();

        let err = acquire_impl(board.path(), Duration::from_millis(100)).unwrap_err();
        match err {
            LockError::Busy { pid: p, writer, .. } => {
                assert_eq!(p, pid);
                assert_eq!(writer, "cli");
            }
            other => panic!("expected Busy, got {other:?}"),
        }
    }

    #[cfg(windows)]
    #[test]
    fn node_written_lock_with_dead_pid_is_swept() {
        let board = unique_board();
        let lock_path = lock_path_for(board.path());
        let mut child = std::process::Command::new("cmd").args(["/c", "exit"]).spawn().unwrap();
        let dead_pid = child.id();
        child.wait().unwrap();
        std::fs::write(&lock_path, node_content(dead_pid, "cli", &now_ms())).unwrap();

        let lock = acquire_impl(board.path(), Duration::from_millis(500)).unwrap();
        drop(lock);
    }

    #[test]
    fn lock_file_path_and_content_match_node_shape() {
        let board = unique_board();
        let lock = acquire_impl(board.path(), Duration::from_millis(200)).unwrap();

        let expected_path = {
            let mut p = board.path().as_os_str().to_os_string();
            p.push(".lock");
            PathBuf::from(p)
        };
        assert_eq!(lock_path_for(board.path()), expected_path);

        let content = std::fs::read_to_string(lock_path_for(board.path())).unwrap();
        let value: Value = serde_json::from_str(&content).unwrap();
        assert!(value.get("pid").unwrap().is_number());
        assert!(value.get("writer").unwrap().is_string());
        let at = value.get("at").unwrap().as_str().unwrap();
        let re_millis_z =
            |s: &str| s.len() == 24 && s.ends_with('Z') && s.as_bytes()[19] == b'.';
        assert!(re_millis_z(at), "at not in Node's millis-Z shape: {at}");
        drop(lock);
    }

    #[test]
    fn stale_by_age_with_live_pid_is_swept_on_acquire() {
        let board = unique_board();
        let lock_path = lock_path_for(board.path());
        let pid = std::process::id();
        let old_at = (chrono::Utc::now() - chrono::Duration::minutes(11))
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        std::fs::write(&lock_path, node_content(pid, "cli", &old_at)).unwrap();

        let lock = acquire_impl(board.path(), Duration::from_millis(200)).unwrap();
        let content = std::fs::read_to_string(&lock_path).unwrap();
        assert!(content.contains("\"writer\":\"app\""));
        drop(lock);
    }

    #[test]
    fn release_does_not_remove_a_foreign_lock() {
        let board = unique_board();
        let lock_path = lock_path_for(board.path());
        let foreign_pid = std::process::id().wrapping_add(999_999).max(1);
        std::fs::write(&lock_path, node_content(foreign_pid, "cli", &now_ms())).unwrap();

        release_file(&lock_path);

        assert!(lock_path.exists());
    }
}
