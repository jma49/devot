//! A rotation on iCloud in CloudKit (docs/adr/0017-sync-key-rotation.md, On iCloud): the
//! successor's zone and epoch, the successor record in zone `devot` that names it to the devices
//! holding the old key, and what is left of the old vault once the rotating device switched. Moving
//! `current` to the successor is `current::replace`.

use super::current;
use super::error::{self, Failure, classify};
use super::kit::{CkRecord, CloudKit, SavePolicy, TYPE_SUCCESSOR, Value, ZONE_DEVOT, vault_zone};
use super::transport;
use crate::sync::{Vault, successor};

const SEALED: &str = "sealed";
const MAC: &str = "mac";
const ROWS_PAGES: usize = 20;
const ROWS_PAGE: usize = 200;

/// One per rotation, so the record of a rotation that lost the race never stands for the winner's.
pub(crate) fn successor_name(from: &str, to: &str) -> String {
    format!("successor-{from}-{to}")
}

/// Makes the successor's zone and its epoch, as its first connect would.
pub(crate) fn make_successor(kit: &dyn CloudKit, next: &Vault) -> Result<(), &'static str> {
    let id = next.id().to_string();
    let zone = vault_zone(&id);
    let exists = kit
        .zones_exist(std::slice::from_ref(&zone))
        .map_err(failure)?;
    if !exists.first().copied().unwrap_or(false) {
        kit.save_zones(&[zone]).map_err(failure)?;
    }
    transport::fetch_epoch(kit, &id)?;
    Ok(())
}

/// Saves in zone `devot` the record that names `next` as the successor of `old`: its ID sealed
/// under `old`'s key, and the MAC under `next`'s key over both IDs.
pub(crate) fn save_successor(
    kit: &dyn CloudKit,
    old: &Vault,
    next: &Vault,
) -> Result<(), &'static str> {
    let sealed = successor::seal(old, next).map_err(|e| e.code())?;
    let record = CkRecord::new(
        TYPE_SUCCESSOR,
        &successor_name(&old.id().to_string(), &next.id().to_string()),
    )
    .with(SEALED, Value::Bytes(sealed))
    .with(MAC, Value::Bytes(successor::mac(next, old.id())));
    kit.save(ZONE_DEVOT, &[record], SavePolicy::Overwrite)
        .map_err(failure)?
        .into_iter()
        .next()
        .ok_or_else(|| error::empty("successor-save"))?
        .map_err(failure)?;
    log::info!(
        "I_SYNC_ICLOUD_SUCCESSOR_SAVED vault={} successor={}",
        old.id(),
        next.id()
    );
    Ok(())
}

/// The MAC of the successor record of `held` for `to`, when that record opens under `held`'s key
/// and names `to`; `None` otherwise.
pub(crate) fn successor(
    kit: &dyn CloudKit,
    held: &Vault,
    to: &str,
) -> Result<Option<Vec<u8>>, &'static str> {
    let name = successor_name(&held.id().to_string(), to);
    let record = match kit.fetch(ZONE_DEVOT, std::slice::from_ref(&name)) {
        Ok(records) => records.into_iter().next().flatten(),
        Err(e) if classify(&e) == Failure::ZoneGone => None,
        Err(e) => return Err(failure(e)),
    };
    let Some(record) = record.filter(|r| r.kind == TYPE_SUCCESSOR) else {
        return Ok(None);
    };
    let (Some(sealed), Some(mac)) = (record.bytes(SEALED), record.bytes(MAC)) else {
        log::warn!(
            "W_SYNC_ICLOUD_SUCCESSOR_UNREADABLE vault={} successor={to}",
            held.id()
        );
        return Ok(None);
    };
    match successor::open(held, to, sealed) {
        Ok(named) if named.to_string() == to => Ok(Some(mac.to_vec())),
        Ok(_) => {
            log::warn!(
                "W_SYNC_ICLOUD_SUCCESSOR_OTHER vault={} successor={to}",
                held.id()
            );
            Ok(None)
        }
        Err(e) => {
            log::warn!(
                "W_SYNC_ICLOUD_SUCCESSOR_UNREADABLE {e} vault={} successor={to}",
                held.id()
            );
            Ok(None)
        }
    }
}

/// Deletes what is left of `vault`, a vault retired for its successor: its zone with its records,
/// then its epoch and device rows in zone `devot`. Its successor record stays, for a device that
/// was offline. Never while `current` names `vault`, and a retry after a failure part way ends the
/// same.
pub(crate) fn clear(kit: &dyn CloudKit, vault: &str) -> Result<(), &'static str> {
    if current::read(kit)?.as_deref() == Some(vault) {
        return Err(error::unusable("retired-current"));
    }
    kit.delete_zones(&[vault_zone(vault)]).map_err(failure)?;
    let mut names = vec![format!("meta-{vault}")];
    names.extend(rows_of(kit, vault)?);
    kit.delete(ZONE_DEVOT, &names).map_err(failure)?;
    log::info!(
        "I_SYNC_ICLOUD_RETIRED_CLEARED vault={vault} rows={}",
        names.len() - 1
    );
    Ok(())
}

/// Deletes what a rotation from `from` to `to` that will not finish made: the successor's zone, its
/// epoch and its successor record. Nothing while `current` names `to`, which is then in use.
pub(crate) fn abandon(kit: &dyn CloudKit, from: &str, to: &str) -> Result<(), &'static str> {
    if current::read(kit)?.as_deref() == Some(to) {
        return Ok(());
    }
    kit.delete_zones(&[vault_zone(to)]).map_err(failure)?;
    kit.delete(
        ZONE_DEVOT,
        &[format!("meta-{to}"), successor_name(from, to)],
    )
    .map_err(failure)?;
    log::info!("I_SYNC_ICLOUD_SUCCESSOR_ABANDONED vault={from} successor={to}");
    Ok(())
}

fn rows_of(kit: &dyn CloudKit, vault: &str) -> Result<Vec<String>, &'static str> {
    let prefix = format!("device-{vault}-");
    let mut names = Vec::new();
    let mut token: Option<Vec<u8>> = None;
    for _ in 0..ROWS_PAGES {
        let page = match kit.changes(ZONE_DEVOT, token.as_deref(), ROWS_PAGE) {
            Ok(page) => page,
            Err(e) if classify(&e) == Failure::ZoneGone => break,
            Err(e) => return Err(failure(e)),
        };
        names.extend(
            page.records
                .iter()
                .filter(|r| r.name.starts_with(&prefix))
                .map(|r| r.name.clone()),
        );
        if !page.more {
            break;
        }
        token = Some(page.token);
    }
    Ok(names)
}

fn failure(e: super::kit::CkError) -> &'static str {
    error::code_of(&e, "rotation")
}

#[cfg(test)]
mod tests {
    use super::super::error::code;
    use super::super::fake::{Fake, Op};
    use super::super::kit::{CkError, TYPE_DEVICE};
    use super::*;

    fn vault() -> Vault {
        Vault::generate().unwrap()
    }

    fn row(kit: &Fake, vault: &str, device: &str) -> String {
        let name = format!("device-{vault}-{device}");
        kit.save(
            ZONE_DEVOT,
            &[CkRecord::new(TYPE_DEVICE, &name).with("day", Value::Int(1))],
            SavePolicy::Overwrite,
        )
        .unwrap();
        name
    }

    #[test]
    fn a_successor_made_twice_keeps_its_first_epoch() {
        let kit = Fake::new();
        current::ensure_zone(&kit).unwrap();
        let next = vault();
        make_successor(&kit, &next).unwrap();
        let id = next.id().to_string();
        assert!(kit.zone_exists(&vault_zone(&id)));
        let meta = kit.record(ZONE_DEVOT, &format!("meta-{id}")).unwrap();
        make_successor(&kit, &next).unwrap();
        assert_eq!(
            kit.record(ZONE_DEVOT, &format!("meta-{id}"))
                .unwrap()
                .text("epoch"),
            meta.text("epoch")
        );
    }

    #[test]
    fn the_successor_record_names_the_successor_to_the_old_key_only() {
        let kit = Fake::new();
        let (old, next) = (vault(), vault());
        let to = next.id().to_string();
        assert_eq!(successor(&kit, &old, &to), Ok(None), "no zone devot yet");
        current::ensure_zone(&kit).unwrap();
        assert_eq!(successor(&kit, &old, &to), Ok(None));
        save_successor(&kit, &old, &next).unwrap();
        let mac = successor(&kit, &old, &to).unwrap().expect("it opens");
        assert!(crate::sync::successor::verify(&next, old.id(), &mac));
        assert_eq!(successor(&kit, &vault(), &to), Ok(None), "another key");
        let other = vault().id().to_string();
        assert_eq!(successor(&kit, &old, &other), Ok(None), "another successor");

        let name = successor_name(&old.id().to_string(), &to);
        let mut swapped = kit.record(ZONE_DEVOT, &name).unwrap();
        let elsewhere = vault();
        swapped.set(
            SEALED,
            Value::Bytes(crate::sync::successor::seal(&old, &elsewhere).unwrap()),
        );
        kit.save(ZONE_DEVOT, &[swapped], SavePolicy::Overwrite)
            .unwrap();
        assert_eq!(
            successor(&kit, &old, &to),
            Ok(None),
            "sealed for another vault"
        );

        kit.fail_next(Op::Fetch, CkError::of(code::NETWORK_UNAVAILABLE));
        assert_eq!(successor(&kit, &old, &to), Err(error::OFFLINE));
    }

    #[test]
    fn clearing_a_retired_vault_deletes_its_zone_epoch_and_rows_and_keeps_the_rest() {
        let kit = Fake::new();
        let (old, next) = (vault(), vault());
        let (from, to) = (old.id().to_string(), next.id().to_string());
        current::claim(&kit, &from).unwrap();
        kit.save_zones(&[vault_zone(&from)]).unwrap();
        make_successor(&kit, &next).unwrap();
        transport::fetch_epoch(&kit, &from).unwrap();
        save_successor(&kit, &old, &next).unwrap();
        let rows = [row(&kit, &from, "a"), row(&kit, &from, "b")];
        let kept = row(&kit, &to, "a");

        assert_eq!(
            clear(&kit, &from),
            Err(error::FAILED),
            "current still names it"
        );
        assert!(kit.zone_exists(&vault_zone(&from)));
        assert_eq!(
            current::replace(&kit, &from, &to),
            Ok(Some(current::Claim::Won))
        );
        kit.fail_next(Op::Delete, CkError::of(code::NETWORK_UNAVAILABLE));
        assert_eq!(clear(&kit, &from), Err(error::OFFLINE));
        assert!(!kit.zone_exists(&vault_zone(&from)), "the zone went first");
        assert!(kit.record(ZONE_DEVOT, &rows[0]).is_some());
        assert_eq!(clear(&kit, &from), Ok(()), "a retry ends the same");
        for name in rows.iter().chain([&format!("meta-{from}")]) {
            assert!(kit.record(ZONE_DEVOT, name).is_none(), "{name}");
        }
        assert!(kit.record(ZONE_DEVOT, &kept).is_some());
        assert!(kit.record(ZONE_DEVOT, &format!("meta-{to}")).is_some());
        assert!(
            kit.record(ZONE_DEVOT, &successor_name(&from, &to))
                .is_some()
        );
        assert!(kit.zone_exists(&vault_zone(&to)));
    }

    #[test]
    fn abandoning_a_rotation_deletes_what_it_made_unless_current_names_it() {
        let kit = Fake::new();
        let (old, next) = (vault(), vault());
        let (from, to) = (old.id().to_string(), next.id().to_string());
        current::claim(&kit, &from).unwrap();
        make_successor(&kit, &next).unwrap();
        save_successor(&kit, &old, &next).unwrap();
        current::replace(&kit, &from, &to).unwrap();
        abandon(&kit, &from, &to).unwrap();
        assert!(kit.zone_exists(&vault_zone(&to)), "in use");
        assert!(
            kit.record(ZONE_DEVOT, &successor_name(&from, &to))
                .is_some()
        );

        let lost = vault();
        let lost_id = lost.id().to_string();
        make_successor(&kit, &lost).unwrap();
        save_successor(&kit, &old, &lost).unwrap();
        abandon(&kit, &from, &lost_id).unwrap();
        assert!(!kit.zone_exists(&vault_zone(&lost_id)));
        assert!(kit.record(ZONE_DEVOT, &format!("meta-{lost_id}")).is_none());
        assert!(
            kit.record(ZONE_DEVOT, &successor_name(&from, &lost_id))
                .is_none()
        );
        assert!(kit.zone_exists(&vault_zone(&to)));
    }
}
