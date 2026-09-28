//! A single, revisioned parsed view of `todos.json` shared by board readers.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use super::todos::{self, LoadOutcome, TodoFile};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileStamp {
    pub modified: SystemTime,
    pub len: u64,
}

impl FileStamp {
    pub fn read(path: &Path) -> Option<Self> {
        let metadata = std::fs::metadata(path).ok()?;
        Some(Self { modified: metadata.modified().ok()?, len: metadata.len() })
    }
}

#[derive(Clone)]
pub struct BoardSnapshot {
    pub revision: u64,
    pub stamp: Option<FileStamp>,
    pub file: Arc<TodoFile>,
}

#[derive(Default)]
pub struct BoardCache {
    inner: Mutex<CacheInner>,
}

#[derive(Default)]
struct CacheInner {
    next_revision: u64,
    snapshot: Option<Arc<BoardSnapshot>>,
}

impl BoardCache {
    pub fn matches(&self, path: &Path) -> bool {
        let stamp = FileStamp::read(path);
        let inner = self.inner.lock().unwrap();
        matches!((&stamp, &inner.snapshot), (Some(stamp), Some(snapshot)) if snapshot.stamp.as_ref() == Some(stamp))
    }

    /// Return the cached parse only when both mtime and length agree.  A missing
    /// stamp is deliberately never trusted: external writers can otherwise hide
    /// a same-second replacement from us.
    pub fn load(&self, path: &Path) -> Result<Arc<BoardSnapshot>, LoadOutcome> {
        let stamp = FileStamp::read(path);
        let mut inner = self.inner.lock().unwrap();
        if let (Some(stamp), Some(snapshot)) = (&stamp, &inner.snapshot) {
            if snapshot.stamp.as_ref() == Some(stamp) {
                return Ok(snapshot.clone());
            }
        }
        match todos::load_checked(path) {
            LoadOutcome::Ok(file) => Ok(Self::install_locked(&mut inner, stamp, file)),
            LoadOutcome::Missing => Ok(Self::install_locked(&mut inner, None, TodoFile::default())),
            other => {
                // Don't serve an old valid board after an unreadable external edit.
                inner.snapshot = None;
                Err(other)
            }
        }
    }

    pub fn install(&self, path: &Path, file: TodoFile) -> Arc<BoardSnapshot> {
        let mut inner = self.inner.lock().unwrap();
        Self::install_locked(&mut inner, FileStamp::read(path), file)
    }

    fn install_locked(inner: &mut CacheInner, stamp: Option<FileStamp>, file: TodoFile) -> Arc<BoardSnapshot> {
        inner.next_revision = inner.next_revision.saturating_add(1);
        let snapshot = Arc::new(BoardSnapshot {
            revision: inner.next_revision,
            stamp,
            file: Arc::new(file),
        });
        inner.snapshot = Some(snapshot.clone());
        snapshot
    }
}
