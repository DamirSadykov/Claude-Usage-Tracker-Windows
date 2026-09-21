//! System resource sampling for the mini panel — whole-machine CPU load and
//! RAM usage. Deliberately scoped to CPU usage + physical RAM only: we never
//! enumerate processes, disks or network, so the work each tick is two cheap
//! kernel reads (and no behavioural-AV-sensitive process walking).

use std::time::Duration;

use serde::Serialize;
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};

/// Whole-system resource snapshot pushed to the frontend as `system-stats`.
#[derive(Serialize, Clone, Default)]
pub struct SysStats {
    /// Total CPU load across all cores, 0..100.
    pub cpu_percent: f64,
    /// Physical RAM in use, in MiB.
    pub mem_used_mb: u64,
    /// Total physical RAM, in MiB.
    pub mem_total_mb: u64,
    /// Used / total RAM, 0..100.
    pub mem_percent: f64,
}

/// Reusable sampler. CPU usage is a delta between two refreshes, so a single
/// `Sampler` is kept alive across ticks and `prime()`d ~`MINIMUM_CPU_UPDATE_INTERVAL`
/// before each `sample()` to get an accurate instantaneous reading.
pub struct Sampler {
    sys: System,
}

impl Sampler {
    pub fn new() -> Self {
        // Refresh nothing by default; opt in to just CPU usage and RAM.
        let specifics = RefreshKind::nothing()
            .with_cpu(CpuRefreshKind::nothing().with_cpu_usage())
            .with_memory(MemoryRefreshKind::nothing().with_ram());
        Self {
            sys: System::new_with_specifics(specifics),
        }
    }

    /// The minimum wait the kernel needs between two CPU refreshes for the load
    /// delta to be meaningful.
    pub fn cpu_settle() -> Duration {
        sysinfo::MINIMUM_CPU_UPDATE_INTERVAL
    }

    /// Take a baseline CPU reading. Call once, wait `cpu_settle()`, then `sample()`.
    pub fn prime(&mut self) {
        self.sys.refresh_cpu_usage();
    }

    pub fn sample(&mut self) -> SysStats {
        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory();

        let total = self.sys.total_memory();
        let used = self.sys.used_memory();
        let mem_percent = if total > 0 {
            used as f64 / total as f64 * 100.0
        } else {
            0.0
        };

        SysStats {
            cpu_percent: self.sys.global_cpu_usage() as f64,
            mem_used_mb: used / 1024 / 1024,
            mem_total_mb: total / 1024 / 1024,
            mem_percent,
        }
    }
}
