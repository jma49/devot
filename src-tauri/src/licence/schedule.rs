//! The licence's daily checks: the revocation list and the seat. The desktop runs them from the
//! updater's scheduler (`updates::start`), a phone from `start`.

use super::{Licence, revoked};
use std::time::{Duration, SystemTime};

pub(crate) const FIRST_CHECK: Duration = Duration::from_secs(30);
pub(crate) const CHECK_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
/// Wall-clock time, so a device that slept through the day checks soon after it wakes.
pub(crate) const WAKE_EVERY: Duration = Duration::from_secs(15 * 60);

pub(crate) fn due(last: Option<SystemTime>, now: SystemTime, every: Duration) -> bool {
    last.is_none_or(|at| now.duration_since(at).is_ok_and(|gone| gone >= every) || now < at)
}

/// How long the revocation list waits after `failures` fetches in a row failed: the next wake,
/// then twice as long each time, never more than a day.
pub(crate) fn retry_after(failures: u32) -> Duration {
    let doublings = failures.saturating_sub(1).min(16);
    WAKE_EVERY.saturating_mul(1 << doublings).min(CHECK_EVERY)
}

/// When each check last succeeded; a failed seat check is tried again at the next wake, a failed
/// list fetch after `retry_after`.
#[derive(Default)]
pub(crate) struct Checks {
    revocations: Option<SystemTime>,
    revocations_failed: Option<(SystemTime, u32)>,
    seat: Option<SystemTime>,
}

impl Checks {
    pub(crate) fn run(&mut self, licence: &Licence) {
        self.run_due(
            SystemTime::now(),
            || {
                licence
                    .wants_revocations()
                    .then(|| revoked::refresh_from_site(licence))
            },
            || licence.refresh_activation_if_due(),
        );
    }

    /// `revocations` answers None when there is no list to fetch (no licence held), which neither
    /// counts as a failure nor waits.
    fn run_due(
        &mut self,
        now: SystemTime,
        revocations: impl FnOnce() -> Option<bool>,
        seat: impl FnOnce() -> bool,
    ) {
        let revocations_due = match self.revocations_failed {
            Some((at, failures)) => due(Some(at), now, retry_after(failures)),
            None => due(self.revocations, now, CHECK_EVERY),
        };
        if revocations_due {
            match revocations() {
                Some(true) => {
                    self.revocations = Some(now);
                    self.revocations_failed = None;
                }
                Some(false) => {
                    let failures = self.revocations_failed.map_or(0, |(_, n)| n);
                    self.revocations_failed = Some((now, failures.saturating_add(1)));
                }
                None => {}
            }
        }
        if due(self.seat, now, CHECK_EVERY) && seat() {
            self.seat = Some(now);
        }
    }
}

#[cfg(mobile)]
pub(crate) fn start(app: &tauri::AppHandle) {
    use std::sync::Arc;
    use tauri::Manager;

    let licence = app
        .try_state::<Arc<Licence>>()
        .map(|l| Arc::clone(&l))
        .filter(|l| l.gated());
    let Some(licence) = licence else { return };
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("devot-licence-checks".into())
        .spawn(move || {
            let mut checks = Checks::default();
            let mut pause = FIRST_CHECK;
            while crate::exit::wait_unless_exiting(&app, pause) {
                pause = WAKE_EVERY;
                checks.run(&licence);
            }
        });
    if spawned.is_err() {
        log::warn!("W_LICENCE_SCHEDULER_FAILED");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn run(checks: &mut Checks, now: SystemTime, succeeds: bool) -> (u32, u32) {
        let (revocations, seat) = (Cell::new(0), Cell::new(0));
        checks.run_due(
            now,
            || {
                revocations.set(1);
                Some(succeeds)
            },
            || {
                seat.set(1);
                succeeds
            },
        );
        (revocations.get(), seat.get())
    }

    #[test]
    fn both_checks_run_once_a_day_after_succeeding() {
        let start = SystemTime::now();
        let mut checks = Checks::default();
        assert_eq!(run(&mut checks, start, true), (1, 1));
        assert_eq!(run(&mut checks, start + WAKE_EVERY, true), (0, 0));
        assert_eq!(run(&mut checks, start + CHECK_EVERY, true), (1, 1));
    }

    #[test]
    fn a_failed_check_is_tried_again_at_the_next_wake() {
        let start = SystemTime::now();
        let mut checks = Checks::default();
        assert_eq!(run(&mut checks, start, false), (1, 1));
        assert_eq!(run(&mut checks, start + WAKE_EVERY, true), (1, 1));
    }

    #[test]
    fn a_list_that_keeps_failing_waits_twice_as_long_each_time_up_to_a_day() {
        assert_eq!(retry_after(1), WAKE_EVERY);
        assert_eq!(retry_after(2), WAKE_EVERY * 2);
        assert_eq!(retry_after(3), WAKE_EVERY * 4);
        assert_eq!(retry_after(7), WAKE_EVERY * 64);
        assert_eq!(retry_after(8), CHECK_EVERY);
        assert_eq!(retry_after(u32::MAX), CHECK_EVERY);

        let fetches = Cell::new(0);
        let mut checks = Checks::default();
        let tick = |checks: &mut Checks, at: SystemTime, succeeds: bool| {
            let before = fetches.get();
            checks.run_due(
                at,
                || {
                    fetches.set(fetches.get() + 1);
                    Some(succeeds)
                },
                || true,
            );
            fetches.get() > before
        };
        let start = SystemTime::now();
        let mut at = start;
        let mut fetched_at = Vec::new();
        while at < start + 3 * CHECK_EVERY {
            if tick(&mut checks, at, false) {
                fetched_at.push(at.duration_since(start).unwrap());
            }
            at += WAKE_EVERY;
        }
        let gaps: Vec<Duration> = fetched_at.windows(2).map(|w| w[1] - w[0]).collect();
        assert_eq!(
            gaps[..5],
            [
                WAKE_EVERY,
                WAKE_EVERY * 2,
                WAKE_EVERY * 4,
                WAKE_EVERY * 8,
                WAKE_EVERY * 16
            ]
        );
        assert!(gaps.iter().all(|gap| *gap <= CHECK_EVERY));
        assert_eq!(gaps.last(), Some(&CHECK_EVERY));

        // One success ends the backoff: the list then waits a day, and a new failure the next wake.
        assert!(tick(&mut checks, at + CHECK_EVERY, true));
        assert!(!tick(&mut checks, at + CHECK_EVERY + WAKE_EVERY, false));
        assert!(tick(&mut checks, at + 2 * CHECK_EVERY, false));
        assert!(tick(&mut checks, at + 2 * CHECK_EVERY + WAKE_EVERY, false));
    }

    #[test]
    fn no_list_to_fetch_is_not_a_failure_and_is_asked_again_at_the_next_wake() {
        let asked = Cell::new(0);
        let mut checks = Checks::default();
        let start = SystemTime::now();
        for wake in 0..4 {
            checks.run_due(
                start + WAKE_EVERY * wake,
                || {
                    asked.set(asked.get() + 1);
                    None
                },
                || true,
            );
        }
        assert_eq!(asked.get(), 4);
        assert!(checks.revocations_failed.is_none());
    }
}
