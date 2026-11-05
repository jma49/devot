//! The Apple ID's one vault (docs/adr/0015-sync-through-icloud-with-devots-own-encryption.md):
//! `current` in zone `devot` names it. It is saved only if absent, so of two first devices at once
//! one vault wins, and a device keeps a new vault key only after its `current` was saved.

use super::error::{self, Failure, classify};
use super::kit::{Account, CURRENT, CkRecord, CloudKit, SavePolicy, TYPE_VAULT, Value, ZONE_DEVOT};
use super::transport::ACCOUNT_UNAVAILABLE;

const VAULT: &str = "vault";

/// Whether this build may use iCloud and the account is signed in and usable.
pub(crate) fn ready(kit: &dyn CloudKit) -> Result<(), &'static str> {
    if !kit.available() {
        return Err(error::UNAVAILABLE);
    }
    match kit.account().map_err(code)? {
        Account::Available => Ok(()),
        Account::Missing => Err(error::SIGNED_OUT),
        Account::Restricted => Err(error::RESTRICTED),
        Account::TemporarilyUnavailable | Account::CouldNotDetermine => Err(ACCOUNT_UNAVAILABLE),
    }
}

/// The vault `current` names; `None` when this Apple ID has none (or no zone `devot` yet).
pub(crate) fn read(kit: &dyn CloudKit) -> Result<Option<String>, &'static str> {
    match kit.fetch(ZONE_DEVOT, &[CURRENT.to_string()]) {
        Ok(records) => Ok(records.into_iter().next().flatten().and_then(vault_of)),
        Err(e) if classify(&e) == Failure::ZoneGone => Ok(None),
        Err(e) => Err(code(e)),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Claim {
    /// `current` names this vault: saved now, or already.
    Won,
    /// Another vault was saved first; this is its ID.
    Lost(String),
}

/// Saves `current` naming `vault` only if no `current` exists.
pub(crate) fn claim(kit: &dyn CloudKit, vault: &str) -> Result<Claim, &'static str> {
    ensure_zone(kit)?;
    let record = CkRecord::new(TYPE_VAULT, CURRENT).with(VAULT, Value::Text(vault.to_string()));
    let saved = kit
        .save(ZONE_DEVOT, &[record], SavePolicy::IfUnchanged)
        .map_err(code)?
        .into_iter()
        .next()
        .ok_or(error::FAILED)?;
    let winner = match saved {
        Ok(_) => {
            log::info!("I_SYNC_ICLOUD_CURRENT vault={vault}");
            return Ok(Claim::Won);
        }
        Err(e) => match (classify(&e), e.server_record) {
            (Failure::Changed, Some(server)) => vault_of(*server).ok_or(error::FAILED)?,
            (failure, _) => return Err(failure.code()),
        },
    };
    if winner == vault {
        return Ok(Claim::Won);
    }
    log::info!("I_SYNC_ICLOUD_CURRENT_LOST vault={vault} winner={winner}");
    Ok(Claim::Lost(winner))
}

pub(crate) fn ensure_zone(kit: &dyn CloudKit) -> Result<(), &'static str> {
    let zone = [ZONE_DEVOT.to_string()];
    let exists = kit.zones_exist(&zone).map_err(code)?;
    if exists.first().copied().unwrap_or(false) {
        return Ok(());
    }
    kit.save_zones(&zone).map_err(code)
}

/// Whether a zone exists, as a recovery key's vault zone does on the Apple ID that holds it.
pub(crate) fn zone_exists(kit: &dyn CloudKit, zone: &str) -> Result<bool, &'static str> {
    let exists = kit.zones_exist(&[zone.to_string()]).map_err(code)?;
    Ok(exists.first().copied().unwrap_or(false))
}

fn vault_of(record: CkRecord) -> Option<String> {
    let vault = record.text(VAULT)?;
    uuid::Uuid::parse_str(vault)
        .is_ok()
        .then(|| vault.to_string())
}

fn code(e: super::kit::CkError) -> &'static str {
    let failure = classify(&e);
    if let Failure::Other(code) = failure {
        log::warn!("W_SYNC_ICLOUD_FAILED code={code}");
    }
    failure.code()
}

#[cfg(test)]
mod tests {
    use super::super::error::code;
    use super::super::fake::{Fake, Op};
    use super::super::kit::CkError;
    use super::*;

    const A: &str = "0192f4c8-7a1b-7c3d-8e9f-0123456789a1";
    const B: &str = "0192f4c8-7a1b-7c3d-8e9f-0123456789a2";

    #[test]
    fn the_first_vault_saved_is_the_apple_id_s_and_a_later_one_loses_to_it() {
        let kit = Fake::new();
        assert_eq!(read(&kit), Ok(None));
        assert_eq!(claim(&kit, A), Ok(Claim::Won));
        assert_eq!(read(&kit), Ok(Some(A.to_string())));
        assert_eq!(claim(&kit, A), Ok(Claim::Won), "saved already");
        assert_eq!(claim(&kit, B), Ok(Claim::Lost(A.to_string())));
        assert_eq!(read(&kit), Ok(Some(A.to_string())), "never replaced");
    }

    #[test]
    fn a_damaged_current_names_no_vault() {
        let kit = Fake::new();
        ensure_zone(&kit).unwrap();
        let damaged = CkRecord::new(TYPE_VAULT, CURRENT).with(VAULT, Value::Text("x".into()));
        kit.save(ZONE_DEVOT, &[damaged], SavePolicy::Overwrite)
            .unwrap();
        assert_eq!(read(&kit), Ok(None));
        assert_eq!(claim(&kit, A), Err(error::FAILED));
    }

    #[test]
    fn ready_needs_the_container_and_a_usable_account() {
        assert_eq!(ready(&Fake::new()), Ok(()));
        assert_eq!(
            ready(&Fake::new().without_entitlement()),
            Err(error::UNAVAILABLE)
        );
        let kit = Fake::new();
        for (account, refused) in [
            (Account::Missing, error::SIGNED_OUT),
            (Account::Restricted, error::RESTRICTED),
            (Account::TemporarilyUnavailable, ACCOUNT_UNAVAILABLE),
        ] {
            kit.set_account(account);
            assert_eq!(ready(&kit), Err(refused));
        }
        let kit = Fake::new();
        kit.fail_next(Op::Fetch, CkError::of(code::NETWORK_UNAVAILABLE));
        assert_eq!(read(&kit), Err(error::OFFLINE));
    }
}
