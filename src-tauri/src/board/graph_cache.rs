
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::board::cache::FileStamp;
use crate::board::task_sessions::TaskBlock;
use crate::contracts::analytics_read::BlockTotals;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GraphCacheKey {
    pub board_revision: u64,
    pub journal_stamp: Option<FileStamp>,
    pub attribution_stamp: Option<FileStamp>,
    pub sqlite_revision: (i64, u64),
}

#[derive(Clone)]
pub struct GraphMetrics {
    pub blocks: Vec<TaskBlock>,
    pub totals: Vec<BlockTotals>,
    pub task_costs: HashMap<String, f64>,
}

#[derive(Default)]
pub struct GraphCache {
    inner: Mutex<Option<(GraphCacheKey, Arc<GraphMetrics>)>>,
}

impl GraphCache {
    pub fn get_or_compute<E>(
        &self,
        key: GraphCacheKey,
        compute: impl FnOnce() -> Result<GraphMetrics, E>,
    ) -> Result<Arc<GraphMetrics>, E> {
        let mut inner = self.inner.lock().unwrap();
        if let Some((cached_key, metrics)) = inner.as_ref() {
            if cached_key == &key {
                return Ok(metrics.clone());
            }
        }
        let metrics = Arc::new(compute()?);
        *inner = Some((key, metrics.clone()));
        Ok(metrics)
    }
}
