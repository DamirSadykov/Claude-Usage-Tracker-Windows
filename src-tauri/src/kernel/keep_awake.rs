use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, SystemTime};

pub const TRANSCRIPT_ACTIVITY_WINDOW: Duration = Duration::from_secs(10 * 60);
pub const RUN_STEP_ACTIVITY_WINDOW: Duration = Duration::from_secs(2 * 60 * 60);
pub const POLL_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Default)]
pub struct Activity {
    pub enabled: bool,
    pub newest_transcript: Option<SystemTime>,
    pub open_run_steps: Vec<SystemTime>,
}

fn is_recent(at: SystemTime, now: SystemTime, window: Duration) -> bool {
    now.duration_since(at).map_or(true, |age| age <= window)
}

pub fn should_keep_awake(activity: &Activity, now: SystemTime) -> bool {
    activity.enabled
        && (activity
            .newest_transcript
            .is_some_and(|mtime| is_recent(mtime, now, TRANSCRIPT_ACTIVITY_WINDOW))
            || activity
                .open_run_steps
                .iter()
                .copied()
                .any(|start| is_recent(start, now, RUN_STEP_ACTIVITY_WINDOW)))
}

#[cfg(windows)]
fn set_system_required(required: bool) {
    use windows_sys::Win32::System::Power::{
        SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
    };

    unsafe {
        SetThreadExecutionState(if required {
            ES_CONTINUOUS | ES_SYSTEM_REQUIRED
        } else {
            ES_CONTINUOUS
        });
    }
}

#[cfg(not(windows))]
fn set_system_required(_required: bool) {}

fn run(mut sample: impl FnMut() -> Activity, wake: Receiver<()>) -> ! {
    let mut applied = false;
    loop {
        let required = should_keep_awake(&sample(), SystemTime::now());
        if required != applied {
            set_system_required(required);
            applied = required;
        }
        let _ = wake.recv_timeout(POLL_INTERVAL);
    }
}

#[derive(Clone)]
pub struct WakeHandle(Sender<()>);

impl WakeHandle {
    pub fn wake(&self) {
        let _ = self.0.send(());
    }
}

pub fn spawn(sample: impl FnMut() -> Activity + Send + 'static) -> WakeHandle {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || run(sample, receiver));
    WakeHandle(sender)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ago(now: SystemTime, age: Duration) -> SystemTime {
        now.checked_sub(age).unwrap()
    }

    #[test]
    fn disabled_never_holds_even_with_fresh_evidence() {
        let now = SystemTime::now();
        let a = Activity {
            enabled: false,
            newest_transcript: Some(now),
            open_run_steps: vec![now],
        };
        assert!(!should_keep_awake(&a, now));
    }

    #[test]
    fn fresh_transcript_holds_and_ten_minute_boundary_is_inclusive() {
        let now = SystemTime::now();
        let a = Activity {
            enabled: true,
            newest_transcript: Some(ago(now, TRANSCRIPT_ACTIVITY_WINDOW)),
            ..Default::default()
        };
        assert!(should_keep_awake(&a, now));
        let stale = Activity {
            enabled: true,
            newest_transcript: Some(ago(
                now,
                TRANSCRIPT_ACTIVITY_WINDOW + Duration::from_secs(1),
            )),
            ..Default::default()
        };
        assert!(!should_keep_awake(&stale, now));
    }

    #[test]
    fn recent_open_run_step_holds_for_two_hours_without_a_transcript() {
        let now = SystemTime::now();
        let a = Activity {
            enabled: true,
            newest_transcript: None,
            open_run_steps: vec![ago(now, RUN_STEP_ACTIVITY_WINDOW)],
        };
        assert!(should_keep_awake(&a, now));
        let stale = Activity {
            enabled: true,
            newest_transcript: None,
            open_run_steps: vec![ago(now, RUN_STEP_ACTIVITY_WINDOW + Duration::from_secs(1))],
        };
        assert!(!should_keep_awake(&stale, now));
    }
}
