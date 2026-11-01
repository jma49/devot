//! This device's seat on a licence (docs/licensing.md, Activation): the Worker's signed lease,
//! checked offline against the keys the build holds, and the migration window a key held before
//! this build had no lease at all.
//!
//! The lease names the licence and this device, so a lease copied from another device does not
//! verify here. A lease lasts 30 days; while it is within 7 days of its end the daily schedule
//! renews it, and a device that stays offline past its end is read-only until it reaches the
//! Worker again.

use serde::{Deserialize, Serialize};

use super::format::{KeyRing, verify_activation};
use super::store::KeyStore;

pub(crate) const ACTIVATION_ACCOUNT: &str = "activation";
/// How long a key held before this build had a lease keeps working offline after the update.
pub(crate) const MIGRATION_DAYS: i64 = 30;
/// Keys issued before seats existed keep working offline for this long after the update. A key
/// issued after it has no such window: it was bought on a machine that could reach the Worker.
pub(crate) const SEATS_SINCE: &str = "2026-11-01T00:00:00Z";
/// The lease is renewed once it is this close to its end.
const REFRESH_BEFORE_MS: i64 = 7 * 86_400_000;
const DAY_MS: i64 = 86_400_000;

/// Whether a key was issued before seats existed, and so may use a migration window.
pub(crate) fn predates_seats(issued_at: &str) -> bool {
    issued_at < SEATS_SINCE
}

/// Whether an activation failure was the Worker being unreachable, not a refusal.
pub(crate) fn offline(code: &str) -> bool {
    code.starts_with("E_NET_") || code == "E_LICENCE_ACTIVATION_FAILED"
}
/// What the keychain keeps under `activation`: one JSON object, so a lease and the seats it
/// reported are written together.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Stored {
    #[serde(default)]
    pub lease: Option<String>,
    #[serde(default)]
    pub used: u32,
    #[serde(default)]
    pub limit: u32,
    #[serde(default)]
    pub migration: Option<Migration>,
    /// Every licence this device has asked the Worker about. A key whose request was refused gets
    /// no migration window, however often it is pasted again or swapped for another key; only a
    /// key never tried, held from before seats existed, does. Capped so it cannot grow for good.
    #[serde(default)]
    pub attempted: Vec<String>,
}

/// The window a key gets when the Worker could not be reached as it was added.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Migration {
    pub id: String,
    pub first_seen: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum State {
    Active,
    Required,
    Expired,
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Check {
    pub state: State,
    pub expires_at: Option<i64>,
    pub code: Option<&'static str>,
}

pub(crate) fn read(store: &dyn KeyStore) -> Result<Stored, &'static str> {
    match store.get()? {
        None => Ok(Stored::default()),
        Some(text) => serde_json::from_str(&text).map_err(|_| "E_LICENCE_ACTIVATION_UNREADABLE"),
    }
}

pub(crate) fn write(store: &dyn KeyStore, stored: &Stored) -> Result<(), &'static str> {
    let text = serde_json::to_string(stored).map_err(|_| "E_LICENCE_ACTIVATION_WRITE_FAILED")?;
    store.set(&text)
}

/// The seat's state at `now`: a lease that verifies for this licence and device and has not run
/// out, else the migration window, else nothing.
pub(crate) fn check(
    stored: &Stored,
    keys: &dyn KeyRing,
    licence_id: &str,
    device: &str,
    now: i64,
) -> Check {
    if let Some(lease) = stored.lease.as_deref()
        && let Ok(activation) = verify_activation(lease, keys)
        && activation.id == licence_id
        && activation.device == device
        && let Some(expires) = instant_ms(&activation.expires_at)
    {
        return if now < expires {
            Check {
                state: State::Active,
                expires_at: Some(expires),
                code: None,
            }
        } else {
            Check {
                state: State::Expired,
                expires_at: Some(expires),
                code: Some("E_LICENCE_ACTIVATION_EXPIRED"),
            }
        };
    }
    if let Some(migration) = stored.migration.as_ref().filter(|m| m.id == licence_id) {
        let deadline = migration.first_seen.saturating_add(MIGRATION_DAYS * DAY_MS);
        return if now < deadline {
            Check {
                state: State::Active,
                expires_at: Some(deadline),
                code: None,
            }
        } else {
            Check {
                state: State::Required,
                expires_at: Some(deadline),
                code: Some("E_LICENCE_ACTIVATION_REQUIRED"),
            }
        };
    }
    Check {
        state: State::Required,
        expires_at: None,
        code: Some("E_LICENCE_ACTIVATION_REQUIRED"),
    }
}

/// Whether the lease should be renewed now: it is missing, or close to its end.
pub(crate) fn due(
    stored: &Stored,
    keys: &dyn KeyRing,
    licence_id: &str,
    device: &str,
    now: i64,
) -> bool {
    // A migration window is not a lease: the device keeps trying to take its real seat.
    if stored.migration.is_some() {
        return true;
    }
    let checked = check(stored, keys, licence_id, device, now);
    match (checked.state, checked.expires_at) {
        (State::Active, Some(expires)) => expires - now <= REFRESH_BEFORE_MS,
        (State::Required | State::Expired, _) => true,
        (State::Active, None) => true,
    }
}

/// The lease's `expiresAt` as milliseconds since the epoch.
pub(crate) fn instant_ms(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() != 20 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    if bytes[13] != b':' || bytes[16] != b':' || bytes[19] != b'Z' {
        return None;
    }
    let number = |from: usize, to: usize| text.get(from..to)?.parse::<i64>().ok();
    let (year, month, day) = (number(0, 4)?, number(5, 7)?, number(8, 10)?);
    let (hour, minute, second) = (number(11, 13)?, number(14, 16)?, number(17, 19)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let days = days_from_civil(year, month, day);
    Some((days * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000)
}

/// Days since 1970-01-01, by Howard Hinnant's civil-from-days algorithm.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_instants_and_refuses_anything_else() {
        assert_eq!(instant_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(instant_ms("2026-10-31T09:00:00Z"), Some(1_793_437_200_000));
        for bad in [
            "2026-10-31 09:00:00Z",
            "2026-13-01T00:00:00Z",
            "2026-10-31T24:00:00Z",
            "2026-10-31T09:00:00+00:00",
            "2026-10-31T09:00:00",
        ] {
            assert_eq!(instant_ms(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_migration_window_lasts_thirty_days() {
        let stored = Stored {
            migration: Some(Migration {
                id: "id".into(),
                first_seen: 0,
            }),
            ..Stored::default()
        };
        let keys = super::super::testing::test_keys(false);
        assert_eq!(
            check(&stored, &keys, "id", "d", DAY_MS).state,
            State::Active
        );
        let last = check(&stored, &keys, "id", "d", 30 * DAY_MS);
        assert_eq!(last.state, State::Required);
        assert_eq!(last.code, Some("E_LICENCE_ACTIVATION_REQUIRED"));
    }

    #[test]
    fn a_migration_window_keeps_trying_for_a_lease() {
        let stored = Stored {
            migration: Some(Migration {
                id: "id".into(),
                first_seen: 0,
            }),
            ..Stored::default()
        };
        let keys = super::super::testing::test_keys(false);
        assert!(due(&stored, &keys, "id", "d", DAY_MS));
    }
}
