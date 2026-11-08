//! Pairing for a vault on iCloud (docs/adr/0015-sync-through-icloud-with-devots-own-encryption.md,
//! Fallback): the offer waits in a `DevotPairing` record in zone `devot`, named by the pairing ID.
//! Taking it saves its `taken` state against the record as read (`.ifServerRecordUnchanged`), so
//! only one device takes it, and drops the offer. The record's `expires` is the sealed one's copy
//! for the sweep; the joining device checks the sealed one.

use std::sync::Arc;

use super::current;
use super::error::{self, Failure, classify};
use super::kit::{CkError, CkRecord, CloudKit, SavePolicy, TYPE_PAIRING, Value, ZONE_DEVOT};
use crate::sync::client::PairingState;
use crate::sync::pairing::{GRACE_MS, PairingChannel};

const OFFER: &str = "offer";
const STATE: &str = "state";
const PROOF: &str = "proof";
const EXPIRES: &str = "expires";

const OPEN: &str = "open";
const TAKEN: &str = "taken";
const CONFIRMED: &str = "confirmed";
const CLOSED: &str = "closed";

const GONE: &str = "E_SYNC_PAIRING_GONE";
const EXISTS: &str = "E_SYNC_PAIRING_EXISTS";
const ROLE: &str = "E_SYNC_PAIRING_ROLE";
/// Records of zone `devot` read per page by the sweep.
const SWEEP_PAGE: usize = 200;

pub(crate) struct ICloudPairing {
    kit: Arc<dyn CloudKit>,
    /// The showing device's: when its offer expires and its clock now.
    host: Option<(i64, i64)>,
}

impl ICloudPairing {
    pub(crate) fn host(kit: Arc<dyn CloudKit>, expires: i64, now: i64) -> Self {
        Self {
            kit,
            host: Some((expires, now)),
        }
    }

    pub(crate) fn join(kit: Arc<dyn CloudKit>) -> Self {
        Self { kit, host: None }
    }

    fn hosting(&self) -> Result<(i64, i64), &'static str> {
        self.host.ok_or(ROLE)
    }

    fn fetch(&self, id: &str) -> Result<CkRecord, &'static str> {
        let record = match self.kit.fetch(ZONE_DEVOT, &[id.to_string()]) {
            Ok(records) => records.into_iter().next().flatten(),
            Err(e) if classify(&e) == Failure::ZoneGone => None,
            Err(e) => return Err(code(&e)),
        };
        record.filter(|r| r.kind == TYPE_PAIRING).ok_or(GONE)
    }

    /// Saves `record` against the one read; one another device changed first is gone to this one.
    fn save(&self, record: CkRecord, policy: SavePolicy) -> Result<(), &'static str> {
        let saved = self
            .kit
            .save(ZONE_DEVOT, &[record], policy)
            .map_err(|e| code(&e))?
            .into_iter()
            .next()
            .ok_or_else(|| error::empty("pairing-save"))?;
        match saved {
            Ok(_) => Ok(()),
            Err(e) if classify(&e) == Failure::Changed => Err(GONE),
            Err(e) => Err(code(&e)),
        }
    }

    /// Closes the offers whose time is over, which a device that showed them and went away left.
    fn sweep(&self, now: i64) {
        let mut token: Option<Vec<u8>> = None;
        loop {
            let page = match self.kit.changes(ZONE_DEVOT, token.as_deref(), SWEEP_PAGE) {
                Ok(page) => page,
                Err(e) => {
                    log::warn!("W_SYNC_PAIRING_SWEEP code={}", e.code);
                    return;
                }
            };
            for record in page.records {
                let open = matches!(record.text(STATE), Some(OPEN | TAKEN));
                let over = record
                    .int(EXPIRES)
                    .is_none_or(|expires| now > expires.saturating_add(GRACE_MS));
                if record.kind == TYPE_PAIRING && open && over {
                    let name = record.name.clone();
                    if let Err(code) = self.save(closed(record), SavePolicy::Overwrite) {
                        log::warn!("W_SYNC_PAIRING_SWEEP {code} pairing={name}");
                    }
                }
            }
            if !page.more {
                return;
            }
            token = Some(page.token);
        }
    }
}

fn closed(record: CkRecord) -> CkRecord {
    record
        .with(STATE, Value::Text(CLOSED.into()))
        .with(OFFER, Value::Null)
        .with(PROOF, Value::Null)
}

fn code(e: &CkError) -> &'static str {
    error::code_of(e, "pairing")
}

impl PairingChannel for ICloudPairing {
    fn open(&self, id: &str, offer: &[u8]) -> Result<(), &'static str> {
        let (expires, now) = self.hosting()?;
        current::ensure_zone(self.kit.as_ref())?;
        self.sweep(now);
        let record = CkRecord::new(TYPE_PAIRING, id)
            .with(OFFER, Value::Bytes(offer.to_vec()))
            .with(STATE, Value::Text(OPEN.into()))
            .with(EXPIRES, Value::Int(expires));
        self.save(record, SavePolicy::IfUnchanged)
            .map_err(|code| if code == GONE { EXISTS } else { code })
    }

    fn take(&self, id: &str) -> Result<Vec<u8>, &'static str> {
        let record = self.fetch(id)?;
        if record.text(STATE) != Some(OPEN) {
            return Err(GONE);
        }
        let offer = record.bytes(OFFER).ok_or(GONE)?.to_vec();
        let taken = record
            .with(STATE, Value::Text(TAKEN.into()))
            .with(OFFER, Value::Null);
        self.save(taken, SavePolicy::IfUnchanged)?;
        Ok(offer)
    }

    fn confirm(&self, id: &str, proof: &[u8]) -> Result<(), &'static str> {
        let record = self.fetch(id)?;
        if record.text(STATE) != Some(TAKEN) {
            return Err(GONE);
        }
        let confirmed = record
            .with(STATE, Value::Text(CONFIRMED.into()))
            .with(PROOF, Value::Bytes(proof.to_vec()));
        self.save(confirmed, SavePolicy::IfUnchanged)
    }

    fn poll(&self, id: &str) -> Result<PairingState, &'static str> {
        self.hosting()?;
        state_of(&self.fetch(id)?)
    }

    /// Saved against the record as read, so a take that lands meanwhile is the state closed.
    fn close(&self, id: &str) -> Result<Option<PairingState>, &'static str> {
        self.hosting()?;
        loop {
            let record = self.fetch(id)?;
            let state = state_of(&record)?;
            match self.save(closed(record), SavePolicy::IfUnchanged) {
                Err(GONE) => continue,
                saved => return saved.map(|()| Some(state)),
            }
        }
    }
}

fn state_of(record: &CkRecord) -> Result<PairingState, &'static str> {
    match record.text(STATE) {
        Some(OPEN) => Ok(PairingState::Open),
        Some(TAKEN) => Ok(PairingState::Taken),
        Some(CONFIRMED) => Ok(PairingState::Confirmed(
            record.bytes(PROOF).unwrap_or_default().to_vec(),
        )),
        _ => Err(GONE),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::super::fake::Fake;
    use super::super::kit::{Account, Changes};
    use super::*;

    const ID: &str = "pairing-1";
    const NOW: i64 = 1_790_000_000_000;
    const UNTIL: i64 = NOW + 600_000;

    fn kit() -> Arc<Fake> {
        Arc::new(Fake::new())
    }

    fn host(kit: &Arc<Fake>) -> ICloudPairing {
        ICloudPairing::host(Arc::clone(kit) as _, UNTIL, NOW)
    }

    fn join(kit: &Arc<Fake>) -> ICloudPairing {
        ICloudPairing::join(Arc::clone(kit) as _)
    }

    #[test]
    fn an_offer_crosses_zone_devot_once_and_the_confirmation_comes_back() {
        let kit = kit();
        let shown = host(&kit);
        shown.open(ID, b"sealed offer").unwrap();
        let record = kit.record(ZONE_DEVOT, ID).unwrap();
        assert_eq!(record.kind, TYPE_PAIRING);
        assert_eq!(record.int(EXPIRES), Some(UNTIL));
        assert_eq!(shown.poll(ID), Ok(PairingState::Open));

        let phone = join(&kit);
        assert_eq!(phone.take(ID).as_deref(), Ok(&b"sealed offer"[..]));
        assert_eq!(kit.record(ZONE_DEVOT, ID).unwrap().bytes(OFFER), None);
        assert_eq!(shown.poll(ID), Ok(PairingState::Taken));
        assert_eq!(join(&kit).take(ID), Err(GONE), "a second take fails");

        phone.confirm(ID, b"proof").unwrap();
        assert_eq!(
            shown.poll(ID),
            Ok(PairingState::Confirmed(b"proof".to_vec()))
        );
        assert_eq!(phone.confirm(ID, b"again"), Err(GONE));
        assert_eq!(
            shown.close(ID),
            Ok(Some(PairingState::Confirmed(b"proof".to_vec())))
        );
        assert_eq!(shown.poll(ID), Err(GONE));
        assert_eq!(kit.record(ZONE_DEVOT, ID).unwrap().bytes(PROOF), None);
        assert_eq!(shown.close(ID), Err(GONE));
    }

    #[test]
    fn of_two_devices_taking_at_once_one_gets_the_offer() {
        let kit = kit();
        host(&kit).open(ID, b"sealed offer").unwrap();
        let read = kit.fetch(ZONE_DEVOT, &[ID.to_string()]).unwrap()[0]
            .clone()
            .unwrap();
        assert!(join(&kit).take(ID).is_ok());
        let late = read
            .with(STATE, Value::Text(TAKEN.into()))
            .with(OFFER, Value::Null);
        assert_eq!(
            join(&kit).save(late, SavePolicy::IfUnchanged),
            Err(GONE),
            "the save against the record as read is refused"
        );
    }

    #[test]
    fn a_closed_or_missing_offer_is_gone_and_a_pairing_id_is_used_once() {
        let kit = kit();
        assert_eq!(join(&kit).take(ID), Err(GONE), "no zone `devot` yet");
        let shown = host(&kit);
        shown.open(ID, b"sealed offer").unwrap();
        assert_eq!(shown.open(ID, b"another"), Err(EXISTS));
        shown.close(ID).unwrap();
        assert_eq!(join(&kit).take(ID), Err(GONE));
        assert_eq!(join(&kit).take("pairing-2"), Err(GONE));
        let note = CkRecord::new("DevotRecord", "pairing-3").with(STATE, Value::Text(OPEN.into()));
        kit.save(ZONE_DEVOT, &[note], SavePolicy::Overwrite)
            .unwrap();
        assert_eq!(join(&kit).take("pairing-3"), Err(GONE), "not a pairing");
    }

    #[test]
    fn the_showing_device_closes_offers_left_past_their_time() {
        let kit = kit();
        let left = ICloudPairing::host(Arc::clone(&kit) as _, NOW - GRACE_MS - 1, NOW - 600_000);
        left.open("left", b"old offer").unwrap();
        let taken = ICloudPairing::host(Arc::clone(&kit) as _, NOW - GRACE_MS - 1, NOW - 600_000);
        taken.open("taken", b"old offer").unwrap();
        join(&kit).take("taken").unwrap();
        let recent = ICloudPairing::host(Arc::clone(&kit) as _, NOW, NOW - 600_000);
        recent.open("recent", b"offer").unwrap();

        host(&kit).open(ID, b"sealed offer").unwrap();
        for (name, state) in [
            ("left", CLOSED),
            ("taken", CLOSED),
            ("recent", OPEN),
            (ID, OPEN),
        ] {
            let record = kit.record(ZONE_DEVOT, name).unwrap();
            assert_eq!(record.text(STATE), Some(state), "{name}");
        }
        assert_eq!(kit.record(ZONE_DEVOT, "left").unwrap().bytes(OFFER), None);
    }

    /// Zone `devot` where another device takes the offer right after this one's next read.
    struct TakenAfterRead {
        kit: Arc<Fake>,
        armed: AtomicBool,
    }

    impl CloudKit for TakenAfterRead {
        fn available(&self) -> bool {
            self.kit.available()
        }
        fn account(&self) -> Result<Account, CkError> {
            self.kit.account()
        }
        fn user_record_name(&self) -> Result<String, CkError> {
            self.kit.user_record_name()
        }
        fn zones_exist(&self, zones: &[String]) -> Result<Vec<bool>, CkError> {
            self.kit.zones_exist(zones)
        }
        fn save_zones(&self, zones: &[String]) -> Result<(), CkError> {
            self.kit.save_zones(zones)
        }
        fn delete_zones(&self, zones: &[String]) -> Result<(), CkError> {
            self.kit.delete_zones(zones)
        }
        fn delete(&self, zone: &str, names: &[String]) -> Result<(), CkError> {
            self.kit.delete(zone, names)
        }
        fn fetch(&self, zone: &str, names: &[String]) -> Result<Vec<Option<CkRecord>>, CkError> {
            let read = self.kit.fetch(zone, names);
            if self.armed.swap(false, Ordering::Relaxed) {
                join(&self.kit).take(ID).unwrap();
            }
            read
        }
        fn save(
            &self,
            zone: &str,
            records: &[CkRecord],
            policy: SavePolicy,
        ) -> Result<Vec<Result<CkRecord, CkError>>, CkError> {
            self.kit.save(zone, records, policy)
        }
        fn changes(
            &self,
            zone: &str,
            token: Option<&[u8]>,
            limit: usize,
        ) -> Result<Changes, CkError> {
            self.kit.changes(zone, token, limit)
        }
        fn subscribe(&self, zone: &str, id: &str) -> Result<(), CkError> {
            self.kit.subscribe(zone, id)
        }
    }

    #[test]
    fn a_take_that_lands_while_the_offer_closes_is_the_state_it_closed() {
        let kit = kit();
        host(&kit).open(ID, b"sealed offer").unwrap();
        let racing = Arc::new(TakenAfterRead {
            kit: Arc::clone(&kit),
            armed: AtomicBool::new(true),
        });
        let shown = ICloudPairing::host(racing as _, UNTIL, NOW);
        assert_eq!(shown.close(ID), Ok(Some(PairingState::Taken)));
        let record = kit.record(ZONE_DEVOT, ID).unwrap();
        assert_eq!(record.text(STATE), Some(CLOSED));
        assert_eq!(shown.close(ID), Err(GONE));
    }

    #[test]
    fn a_joining_device_s_channel_only_takes_and_confirms() {
        let kit = kit();
        let phone = join(&kit);
        assert_eq!(phone.open(ID, b"offer"), Err(ROLE));
        assert_eq!(phone.poll(ID).err(), Some(ROLE));
        assert_eq!(phone.close(ID), Err(ROLE));
    }
}
