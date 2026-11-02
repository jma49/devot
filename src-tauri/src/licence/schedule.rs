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

/// When each check last succeeded; a failed one is tried again at the next wake.
#[derive(Default)]
pub(crate) struct Checks {
    revocations: Option<SystemTime>,
    seat: Option<SystemTime>,
}

impl Checks {
    pub(crate) fn run(&mut self, licence: &Licence) {
        self.run_due(
            SystemTime::now(),
            || licence.wants_revocations() && revoked::refresh_from_site(licence),
            || licence.refresh_activation_if_due(),
        );
    }

    fn run_due(
        &mut self,
        now: SystemTime,
        revocations: impl FnOnce() -> bool,
        seat: impl FnOnce() -> bool,
    ) {
        if due(self.revocations, now, CHECK_EVERY) && revocations() {
            self.revocations = Some(now);
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
    let spawned = std::thread::Builder::new()
        .name("devot-licence-checks".into())
        .spawn(move || {
            std::thread::sleep(FIRST_CHECK);
            let mut checks = Checks::default();
            loop {
                checks.run(&licence);
                std::thread::sleep(WAKE_EVERY);
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
                succeeds
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
}
