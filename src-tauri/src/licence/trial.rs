//! The three-day trial of a build that checks licences (docs/adr/0006-source-available-and-sold-once.md,
//! The trial). It starts the first time such a build opens, and its start and the latest time seen
//! live in the keychain, which outlives a reinstall. A clock set back more than an hour before the
//! latest time seen ends it for good, so turning the clock back never extends it.

use serde::{Deserialize, Serialize};

const MINUTE_MS: i64 = 60_000;
const HOUR_MS: i64 = 60 * MINUTE_MS;
pub(crate) const LENGTH_MS: i64 = 72 * HOUR_MS;
/// How far behind the latest time seen the clock may be: a correction, not a reset.
pub(crate) const SET_BACK_MS: i64 = HOUR_MS;
/// How long after the end a note's text is still written, so a save in flight lands.
pub(crate) const GRACE_MS: i64 = 5 * MINUTE_MS;
/// How often the latest time seen goes to the keychain while Devot runs.
pub(crate) const SEEN_EVERY_MS: i64 = 10 * MINUTE_MS;

/// The keychain item, as JSON.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Record {
    pub start: i64,
    pub seen: i64,
    /// Set once the clock was found set back; never cleared.
    #[serde(default)]
    pub ended: bool,
}

impl Record {
    pub(crate) fn first(now: i64) -> Self {
        Self {
            start: now,
            seen: now,
            ended: false,
        }
    }

    pub(crate) fn read(text: &str) -> Result<Self, &'static str> {
        let record: Self = serde_json::from_str(text).map_err(|_| "E_TRIAL_UNREADABLE")?;
        if record.start < 0 || record.seen < record.start {
            return Err("E_TRIAL_UNREADABLE");
        }
        Ok(record)
    }

    pub(crate) fn text(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    pub(crate) fn ends_at(&self) -> i64 {
        self.start.saturating_add(LENGTH_MS)
    }

    /// The record once `now` is seen: a later time moves `seen` on, a clock set back past the
    /// allowance ends the trial.
    pub(crate) fn seen_at(self, now: i64) -> Self {
        if now < self.seen.saturating_sub(SET_BACK_MS) {
            Self {
                ended: true,
                ..self
            }
        } else {
            Self {
                seen: self.seen.max(now),
                ..self
            }
        }
    }

    pub(crate) fn running(&self, now: i64) -> bool {
        !self.ended
            && self.start <= now
            && now < self.ends_at()
            && now >= self.seen.saturating_sub(SET_BACK_MS)
    }

    /// Just past a trial that ran out (not one the clock ended).
    pub(crate) fn in_grace(&self, now: i64) -> bool {
        !self.ended && self.ends_at() <= now && now < self.ends_at().saturating_add(GRACE_MS)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TrialState {
    Running,
    Ended,
}

/// What the windows see of the trial.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrialView {
    pub state: TrialState,
    /// Milliseconds since the epoch; none when the trial could not be read.
    pub ends_at: Option<i64>,
    /// Why the trial could not be read; it counts as ended then.
    pub code: Option<&'static str>,
}

impl TrialView {
    pub(crate) fn of(trial: Result<&Record, &'static str>, now: i64) -> Self {
        match trial {
            Ok(record) => Self {
                state: if record.running(now) {
                    TrialState::Running
                } else {
                    TrialState::Ended
                },
                ends_at: Some(record.ends_at()),
                code: None,
            },
            Err(code) => Self {
                state: TrialState::Ended,
                ends_at: None,
                code: Some(code),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const START: i64 = 1_790_000_000_000;

    #[test]
    fn a_fresh_trial_runs_for_seventy_two_hours() {
        let record = Record::first(START);
        assert!(record.running(START));
        assert!(record.running(START + LENGTH_MS - 1));
        assert!(!record.running(START + LENGTH_MS));
        assert_eq!(record.ends_at(), START + 72 * 3_600_000);
    }

    #[test]
    fn the_latest_time_seen_only_moves_on() {
        let record = Record::first(START).seen_at(START + HOUR_MS);
        assert_eq!(record.seen, START + HOUR_MS);
        let back = record.seen_at(START + 30 * MINUTE_MS);
        assert_eq!(back.seen, START + HOUR_MS);
        assert!(!back.ended);
        assert!(back.running(START + 30 * MINUTE_MS));
    }

    #[test]
    fn a_clock_set_back_more_than_an_hour_ends_the_trial_for_good() {
        let seen = Record::first(START).seen_at(START + 10 * HOUR_MS);
        // Not running at a time an hour and more before the latest seen, even before it is recorded.
        assert!(!seen.running(START + 9 * HOUR_MS - 1));
        let back = seen.seen_at(START + 9 * HOUR_MS - 1);
        assert!(back.ended);
        assert!(!back.running(START + 9 * HOUR_MS - 1));
        // Setting the clock right again does not bring the trial back.
        let again = back.seen_at(START + 11 * HOUR_MS);
        assert!(again.ended);
        assert!(!again.running(START + 11 * HOUR_MS));
        assert!(!again.in_grace(again.ends_at()));
    }

    #[test]
    fn a_clock_before_the_start_is_not_in_the_trial() {
        let record = Record::first(START);
        assert!(!record.running(START - 1));
        assert!(!record.seen_at(START - 1).ended);
    }

    #[test]
    fn the_grace_follows_a_trial_that_ran_out() {
        let record = Record::first(START);
        let end = record.ends_at();
        assert!(!record.in_grace(end - 1));
        assert!(record.in_grace(end));
        assert!(record.in_grace(end + GRACE_MS - 1));
        assert!(!record.in_grace(end + GRACE_MS));
    }

    #[test]
    fn the_item_reads_back_and_a_damaged_one_is_refused() {
        let record = Record::first(START).seen_at(START + 5);
        assert_eq!(Record::read(&record.text()), Ok(record));
        assert_eq!(
            Record::read(&format!("{{\"start\":{START},\"seen\":{START}}}")),
            Ok(Record::first(START))
        );
        for bad in [
            "",
            "{}",
            "not json",
            "{\"start\":5,\"seen\":4}",
            "{\"start\":-1,\"seen\":4}",
        ] {
            assert_eq!(Record::read(bad), Err("E_TRIAL_UNREADABLE"), "{bad}");
        }
    }

    #[test]
    fn the_view_says_whether_it_runs_and_when_it_ends() {
        let record = Record::first(START);
        assert_eq!(
            serde_json::to_value(TrialView::of(Ok(&record), START)).unwrap(),
            serde_json::json!({ "state": "running", "endsAt": START + LENGTH_MS, "code": null })
        );
        assert_eq!(
            TrialView::of(Ok(&record), START + LENGTH_MS).state,
            TrialState::Ended
        );
        assert_eq!(
            TrialView::of(Err("E_LICENCE_KEYCHAIN"), START),
            TrialView {
                state: TrialState::Ended,
                ends_at: None,
                code: Some("E_LICENCE_KEYCHAIN"),
            }
        );
    }
}
