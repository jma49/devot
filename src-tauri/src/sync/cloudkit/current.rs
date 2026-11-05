//! The Apple ID's one vault (docs/adr/0015-sync-through-icloud-with-devots-own-encryption.md):
//! `current` in zone `devot` names it. It is saved only if absent, so of two first devices at once
//! one vault wins; a device keeps a new vault key before it saves `current`, and removes it again
//! when another vault won.

use super::error::{self, Failure, classify};
use super::kit::{
    Account, CURRENT, CkRecord, CloudKit, SavePolicy, TYPE_VAULT, Value, ZONE_CLOCK, ZONE_DEVOT,
    vault_zone,
};
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
        Ok(records) => Ok(records
            .into_iter()
            .next()
            .flatten()
            .and_then(|record| vault_of(&record))),
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
        .ok_or_else(|| error::empty("current-save"))?;
    let winner = match saved {
        Ok(_) => {
            log::info!("I_SYNC_ICLOUD_CURRENT vault={vault}");
            return Ok(Claim::Won);
        }
        Err(e) => match (classify(&e), &e.server_record) {
            (Failure::Changed, Some(server)) => {
                vault_of(server).ok_or_else(|| error::unusable("current-vault"))?
            }
            _ => return Err(error::code_of(&e, "current")),
        },
    };
    if winner == vault {
        return Ok(Claim::Won);
    }
    log::info!("I_SYNC_ICLOUD_CURRENT_LOST vault={vault} winner={winner}");
    Ok(Claim::Lost(winner))
}

/// Removes `vault` from this Apple ID (Leave This Vault). Zone `devot`, which holds `current`,
/// goes first, so a device that connects before the vault's zone is gone stops instead of making
/// it again; then the vault's zone, so the other devices find it gone and ask before they upload
/// again; then `devot-clock`. When `current` names another vault, `devot` and `devot-clock` are its
/// own and stay. A zone already gone is skipped, so a retry after a failure part way ends in the
/// same state.
pub(crate) fn leave(kit: &dyn CloudKit, vault: &str) -> Result<(), &'static str> {
    let ours = read(kit)?.is_none_or(|current| current == vault);
    let zones = if ours {
        vec![
            ZONE_DEVOT.to_string(),
            vault_zone(vault),
            ZONE_CLOCK.to_string(),
        ]
    } else {
        vec![vault_zone(vault)]
    };
    for zone in zones {
        kit.delete_zones(std::slice::from_ref(&zone))
            .map_err(code)?;
    }
    log::info!("I_SYNC_ICLOUD_ZONES_DELETED vault={vault} all={ours}");
    Ok(())
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

fn vault_of(record: &CkRecord) -> Option<String> {
    if record.kind != TYPE_VAULT {
        return None;
    }
    let vault = record.text(VAULT)?;
    uuid::Uuid::parse_str(vault)
        .is_ok()
        .then(|| vault.to_string())
}

fn code(e: super::kit::CkError) -> &'static str {
    error::code_of(&e, "current")
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
    fn a_server_rejected_save_fails_the_claim_with_failed() {
        let kit = Fake::new();
        kit.fail_record(CURRENT, CkError::of(code::SERVER_REJECTED_REQUEST));
        assert_eq!(claim(&kit, A), Err(error::FAILED));
    }

    #[test]
    fn a_current_of_another_type_names_no_vault() {
        let kit = Fake::new();
        ensure_zone(&kit).unwrap();
        let pairing = CkRecord::new(super::super::kit::TYPE_PAIRING, CURRENT)
            .with(VAULT, Value::Text(A.into()));
        kit.save(ZONE_DEVOT, &[pairing], SavePolicy::Overwrite)
            .unwrap();
        assert_eq!(read(&kit), Ok(None));
    }

    fn with_vault(kit: &Fake, vault: &str) {
        claim(kit, vault).unwrap();
        kit.save_zones(&[vault_zone(vault), ZONE_CLOCK.to_string()])
            .unwrap();
    }

    #[test]
    fn leaving_deletes_current_s_zone_before_the_vault_s() {
        let kit = Fake::new();
        with_vault(&kit, A);
        assert_eq!(leave(&kit, A), Ok(()));
        assert_eq!(
            kit.deleted_zones(),
            [ZONE_DEVOT, vault_zone(A).as_str(), ZONE_CLOCK]
        );
        assert_eq!(read(&kit), Ok(None));
    }

    #[test]
    fn a_leave_that_failed_at_any_step_ends_the_same_when_retried() {
        for (step, failing) in [ZONE_DEVOT, vault_zone(A).as_str(), ZONE_CLOCK]
            .into_iter()
            .enumerate()
        {
            let kit = Fake::new();
            with_vault(&kit, A);
            kit.fail_zone_delete(failing, CkError::of(code::REQUEST_RATE_LIMITED));
            assert_eq!(leave(&kit, A), Err(error::BUSY), "{failing}");
            assert_eq!(kit.deleted_zones().len(), step, "{failing}");
            let left = (step == 0).then(|| A.to_string());
            assert_eq!(read(&kit), Ok(left), "current goes first: {failing}");
            assert_eq!(leave(&kit, A), Ok(()), "{failing}");
            for zone in [ZONE_DEVOT, vault_zone(A).as_str(), ZONE_CLOCK] {
                assert!(!kit.zone_exists(zone), "{failing}: {zone}");
            }
            assert_eq!(leave(&kit, A), Ok(()), "nothing left to delete");
        }

        let offline = Fake::new();
        with_vault(&offline, A);
        offline.fail_next(Op::Fetch, CkError::of(code::NETWORK_UNAVAILABLE));
        assert_eq!(leave(&offline, A), Err(error::OFFLINE));
        assert!(offline.deleted_zones().is_empty());
    }

    #[test]
    fn a_retry_after_another_vault_claimed_current_keeps_its_zones() {
        let kit = Fake::new();
        with_vault(&kit, A);
        kit.fail_zone_delete(&vault_zone(A), CkError::of(code::NETWORK_UNAVAILABLE));
        assert_eq!(leave(&kit, A), Err(error::OFFLINE));
        assert_eq!(claim(&kit, B), Ok(Claim::Won));
        assert_eq!(leave(&kit, A), Ok(()));
        assert!(!kit.zone_exists(&vault_zone(A)));
        assert_eq!(read(&kit), Ok(Some(B.to_string())));
        assert!(kit.zone_exists(ZONE_CLOCK));
    }

    #[test]
    fn leaving_a_vault_current_does_not_name_keeps_the_zones_of_the_one_it_names() {
        let kit = Fake::new();
        with_vault(&kit, B);
        kit.save_zones(&[vault_zone(A)]).unwrap();
        assert_eq!(leave(&kit, A), Ok(()));
        assert_eq!(kit.deleted_zones(), [vault_zone(A)]);
        assert_eq!(read(&kit), Ok(Some(B.to_string())));
        assert!(kit.zone_exists(&vault_zone(B)) && kit.zone_exists(ZONE_CLOCK));
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
