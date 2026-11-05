use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;

use super::batch::{self, MAX_ASSET_BYTES, MAX_INLINE_BYTES, MAX_RECORDS};
use super::encoding::{self, INLINE_MAX, MAX_CHUNKS, Size};
use super::error::{self, Failure, Refused, classify, code, refused};
use super::fake::{Fake, Op};
use super::kit::{
    Account, CkError, CkRecord, TYPE_RECORD, Value, ZONE_CLOCK, ZONE_DEVOT, vault_zone,
};
use super::staging::Staging;
use super::transport::{ICloud, ICloudState, Item, PushAnswer, open_device_name};
use crate::sync::Vault;

const NOW: i64 = 1_800_000_000_000;
const NAME: &str = "Devot for macOS";

/// ID, version, tag and plaintext of a pulled record.
type PulledRow = (String, u64, String, Vec<u8>);

fn id(n: usize) -> String {
    format!("0190f000-0000-7000-8000-{n:012}")
}

struct Device {
    icloud: ICloud,
    state: ICloudState,
    staging: Arc<Staging>,
    _dir: tempfile::TempDir,
}

fn device(kit: &Arc<Fake>, vault: &Arc<Vault>) -> Device {
    let dir = tempfile::tempdir().unwrap();
    let staging = Arc::new(Staging::new(&dir.path().join(super::staging::DIR)));
    let kit: Arc<dyn super::CloudKit> = kit.clone();
    Device {
        icloud: ICloud::new(kit, Arc::clone(vault), Arc::clone(&staging)),
        state: ICloudState::new(&vault.id().to_string()),
        staging,
        _dir: dir,
    }
}

impl Device {
    fn connect(&mut self, has_synced: bool) -> Result<super::Welcome, &'static str> {
        let (welcome, state) = self.icloud.connect(&self.state, has_synced, NAME, NOW)?;
        self.state = state;
        Ok(welcome)
    }

    fn push(&self, id: &str, base: u64, tag: &str, plaintext: &[u8]) -> PushAnswer {
        self.icloud
            .push_many(
                &[Item {
                    id,
                    base,
                    tag,
                    plaintext,
                    kind: "record",
                }],
                NOW,
            )
            .remove(0)
    }

    /// Pulls every page from `since`: (id, version, tag, plaintext) and the next cursor.
    fn pull_all(&self, since: &str) -> (Vec<PulledRow>, String) {
        let mut cursor = since.to_string();
        let mut out = Vec::new();
        loop {
            let page = self.icloud.pull(&cursor).unwrap();
            for r in page.records {
                out.push((r.id, r.version, r.tag, r.plaintext.unwrap().to_vec()));
            }
            cursor = page.next;
            if !page.more {
                return (out, cursor);
            }
        }
    }
}

/// An Apple ID whose `current` names a new vault, as `use_icloud` leaves it before a first connect.
fn setup() -> (Arc<Fake>, Arc<Vault>) {
    let (kit, vault) = (Arc::new(Fake::new()), Arc::new(Vault::generate().unwrap()));
    super::current::claim(kit.as_ref(), &vault.id().to_string()).unwrap();
    (kit, vault)
}

fn pushed_tag(result: &PushAnswer) -> String {
    match result {
        PushAnswer::Pushed { tag, .. } => tag.clone(),
        other => panic!("not pushed: {other:?}"),
    }
}

fn ck(code: i64) -> CkError {
    CkError::of(code)
}

#[test]
fn a_failed_line_names_its_cause_and_site_but_no_content() {
    assert_eq!(
        error::failed_line("code=12", "current", 1),
        "W_SYNC_ICLOUD_FAILED code=12 at=current count=1"
    );
    assert_eq!(error::code_of(&ck(12), "current"), error::FAILED);
    assert_eq!(error::code_of(&ck(code::QUOTA_EXCEEDED), "x"), error::FULL);
    assert_eq!(error::empty("x"), error::FAILED);
    assert_eq!(error::unusable("x"), error::FAILED);
}

#[test]
fn failures_of_one_pass_log_once_per_cause_with_a_count() {
    let mut tally = error::FailedTally::default();
    for _ in 0..37 {
        tally.note(Some(15));
    }
    tally.note(Some(12));
    tally.note(None);
    tally.note(None);
    assert_eq!(
        tally.lines("push"),
        [
            "W_SYNC_ICLOUD_FAILED empty at=push count=2",
            "W_SYNC_ICLOUD_FAILED code=12 at=push count=1",
            "W_SYNC_ICLOUD_FAILED code=15 at=push count=37",
        ]
    );
    assert!(error::FailedTally::default().lines("push").is_empty());
}

// The error table of ADR 0015, one code at a time.

#[test]
fn maps_every_cloudkit_code_the_adr_names() {
    let busy = |code, retry| {
        classify(&CkError {
            code,
            retry_after_ms: retry,
            server_record: None,
        })
    };
    assert_eq!(classify(&ck(code::SERVER_RECORD_CHANGED)), Failure::Changed);
    for c in [
        code::REQUEST_RATE_LIMITED,
        code::ZONE_BUSY,
        code::SERVICE_UNAVAILABLE,
    ] {
        assert_eq!(
            busy(c, Some(12_000)),
            Failure::Busy {
                retry_after_ms: 12_000
            }
        );
        assert_eq!(
            busy(c, None),
            Failure::Busy {
                retry_after_ms: error::DEFAULT_RETRY_MS
            }
        );
    }
    assert_eq!(classify(&ck(code::QUOTA_EXCEEDED)), Failure::Full);
    assert_eq!(
        classify(&ck(code::CHANGE_TOKEN_EXPIRED)),
        Failure::TokenExpired
    );
    assert_eq!(classify(&ck(code::ZONE_NOT_FOUND)), Failure::ZoneGone);
    assert_eq!(classify(&ck(code::USER_DELETED_ZONE)), Failure::ZoneGone);
    assert_eq!(classify(&ck(code::LIMIT_EXCEEDED)), Failure::TooMany);
    assert_eq!(classify(&ck(code::BATCH_REQUEST_FAILED)), Failure::Again);
    assert_eq!(classify(&ck(code::NOT_AUTHENTICATED)), Failure::SignedOut);
    assert_eq!(
        classify(&ck(code::MANAGED_ACCOUNT_RESTRICTED)),
        Failure::Restricted
    );
    assert_eq!(
        classify(&ck(code::MISSING_ENTITLEMENT)),
        Failure::Unavailable
    );
    assert_eq!(classify(&ck(code::BAD_CONTAINER)), Failure::Unavailable);
    assert_eq!(classify(&ck(code::BAD_TAG)), Failure::BadTag);
    assert_eq!(Failure::BadTag.code(), "E_SYNC_TAG_INVALID");
    for c in [
        code::NETWORK_UNAVAILABLE,
        code::NETWORK_FAILURE,
        code::SERVER_RESPONSE_LOST,
        code::OPERATION_CANCELLED,
        code::ACCOUNT_TEMPORARILY_UNAVAILABLE,
    ] {
        assert_eq!(classify(&ck(c)), Failure::Offline, "{c}");
    }
    for c in [
        code::INTERNAL_ERROR,
        code::PERMISSION_FAILURE,
        code::UNKNOWN_ITEM,
        code::SERVER_REJECTED_REQUEST,
        code::NATIVE,
    ] {
        assert_eq!(classify(&ck(c)), Failure::Other(c), "{c}");
        assert_eq!(Failure::Other(c).code(), error::FAILED);
    }
    assert_eq!(Failure::Full.code(), "E_SYNC_ICLOUD_FULL");
    assert_eq!(Failure::ZoneGone.code(), "E_SYNC_ICLOUD_ZONE_MISSING");
    assert_eq!(Failure::SignedOut.code(), "E_SYNC_ICLOUD_SIGNED_OUT");
    assert_eq!(Failure::Restricted.code(), "E_SYNC_ICLOUD_RESTRICTED");
    assert_eq!(Failure::Unavailable.code(), "E_SYNC_CLOUDKIT_UNAVAILABLE");
    assert_eq!(Failure::Offline.code(), "E_SYNC_OFFLINE");
}

#[test]
fn a_refused_save_becomes_rejected_paused_or_failed() {
    let server = CkRecord::new(TYPE_RECORD, &id(1)).with(encoding::VERSION, Value::Int(4));
    let changed = CkError {
        code: code::SERVER_RECORD_CHANGED,
        retry_after_ms: None,
        server_record: Some(Box::new(server.clone())),
    };
    assert_eq!(
        refused(&changed, NOW),
        Refused::Rejected {
            server: Box::new(server)
        }
    );
    assert_eq!(
        refused(&ck(code::SERVER_RECORD_CHANGED), NOW),
        Refused::Failed(error::FAILED)
    );
    let limited = CkError {
        code: code::REQUEST_RATE_LIMITED,
        retry_after_ms: Some(7_500),
        server_record: None,
    };
    assert_eq!(
        refused(&limited, NOW),
        Refused::Paused {
            until: Some(NOW + 7_500),
            code: "E_SYNC_ICLOUD_BUSY"
        }
    );
    assert_eq!(
        refused(&ck(code::QUOTA_EXCEEDED), NOW),
        Refused::Paused {
            until: None,
            code: "E_SYNC_ICLOUD_FULL"
        }
    );
    assert_eq!(refused(&ck(code::LIMIT_EXCEEDED), NOW), Refused::Again);
    assert_eq!(
        refused(&ck(code::BATCH_REQUEST_FAILED), NOW),
        Refused::Again
    );
    assert_eq!(
        refused(&ck(code::ZONE_NOT_FOUND), NOW),
        Refused::Failed("E_SYNC_ICLOUD_ZONE_MISSING")
    );
    assert_eq!(
        refused(&ck(code::NETWORK_FAILURE), NOW),
        Refused::Failed("E_SYNC_OFFLINE")
    );
}

// Record encoding.

#[test]
fn a_small_record_goes_inline_and_its_sealed_bytes_round_trip() {
    let vault = Vault::generate().unwrap();
    let chunks = vault.encrypt_record(&id(1), 3, b"a small note").unwrap();
    let (record, size) = encoding::encode(&id(1), None, 3, "record", &chunks, &mut |_| {
        panic!("nothing is staged for an inline record")
    })
    .unwrap();
    assert_eq!(record.kind, "DevotRecord");
    assert_eq!(record.int("version"), Some(3));
    assert_eq!(record.text("kind"), Some("record"));
    assert_eq!(record.int("chunkCount"), Some(1));
    assert!(record.bytes("inline").is_some());
    for index in 0..MAX_CHUNKS {
        assert_eq!(
            record
                .fields
                .iter()
                .find(|(k, _)| *k == format!("chunk{index}"))
                .map(|(_, v)| v),
            Some(&Value::Null)
        );
    }
    assert_eq!(size.assets, 0);
    assert_eq!(size.inline, chunks[0].len());
    let decoded = encoding::decode(&record).unwrap();
    assert_eq!(decoded.version, 3);
    let opened = vault
        .decrypt_record(&id(1), decoded.version, &decoded.chunks)
        .unwrap();
    assert_eq!(opened.as_slice(), b"a small note");
}

#[test]
fn a_large_record_goes_in_chunk_assets_up_to_sixteen() {
    let vault = Vault::generate().unwrap();
    let chunks = vault
        .encrypt_in_pieces(&id(2), 1, &vec![7; 3000], 1000)
        .unwrap();
    assert_eq!(chunks.len(), 3);
    let mut staged = Vec::new();
    let (record, size) = encoding::encode(&id(2), None, 1, "file", &chunks, &mut |bytes| {
        staged.push(bytes.to_vec());
        Ok(std::path::PathBuf::from(format!(
            "/staged/{}",
            staged.len()
        )))
    })
    .unwrap();
    assert_eq!(staged, chunks);
    assert_eq!(record.get("inline"), None);
    assert!(matches!(record.get("chunk2"), Some(Value::Asset(_))));
    assert_eq!(record.get("chunk3"), None);
    assert_eq!(size.inline, 0);
    assert_eq!(size.assets, chunks.iter().map(Vec::len).sum::<usize>());

    let too_many: Vec<Vec<u8>> = (0..=MAX_CHUNKS).map(|_| vec![1]).collect();
    assert_eq!(
        encoding::encode(
            &id(3),
            None,
            1,
            "record",
            &too_many,
            &mut |_| unreachable!()
        )
        .err(),
        Some("E_SYNC_TOO_LARGE")
    );
    let big = vec![vec![1; INLINE_MAX + 1]];
    let (record, _) = encoding::encode(&id(4), None, 1, "record", &big, &mut |_| {
        Ok(std::path::PathBuf::from("/staged/x"))
    })
    .unwrap();
    assert_eq!(record.get("inline"), None, "over the inline limit");
}

#[test]
fn decoding_refuses_a_record_that_does_not_add_up() {
    let base = || {
        CkRecord::new(TYPE_RECORD, &id(1))
            .with("version", Value::Int(1))
            .with("kind", Value::Text("record".into()))
    };
    let invalid = [
        base().with("chunkCount", Value::Int(0)),
        base().with("chunkCount", Value::Int(17)),
        base().with("chunkCount", Value::Int(1)),
        base()
            .with("chunkCount", Value::Int(2))
            .with("inline", Value::Bytes(vec![1])),
        base()
            .with("chunkCount", Value::Int(2))
            .with("chunk0", Value::Bytes(vec![1])),
        base()
            .with("chunkCount", Value::Int(1))
            .with("version", Value::Int(0))
            .with("inline", Value::Bytes(vec![1])),
        CkRecord::new("DevotMeta", &id(1)),
    ];
    for record in invalid {
        assert_eq!(
            encoding::decode(&record).err(),
            Some("E_SYNC_ICLOUD_RECORD_INVALID")
        );
    }
}

// Batches.

#[test]
fn batches_are_capped_by_records_inline_bytes_and_assets() {
    let small = Size {
        inline: 100,
        assets: 0,
    };
    let lens = |runs: Vec<std::ops::Range<usize>>| runs.iter().map(|r| r.len()).collect::<Vec<_>>();
    assert_eq!(lens(batch::plan(&vec![small; 450])), [200, 200, 50]);
    assert_eq!(MAX_RECORDS, 200);
    let inline = Size {
        inline: 600_000,
        assets: 0,
    };
    const { assert!(2 * 600_000 <= MAX_INLINE_BYTES && 3 * 600_000 > MAX_INLINE_BYTES) };
    assert_eq!(lens(batch::plan(&[inline; 5])), [2, 2, 1]);
    let assets = Size {
        inline: 0,
        assets: 7_000_000,
    };
    const { assert!(2 * 7_000_000 <= MAX_ASSET_BYTES && 3 * 7_000_000 > MAX_ASSET_BYTES) };
    assert_eq!(lens(batch::plan(&[assets; 5])), [2, 2, 1]);
    let huge = Size {
        inline: 0,
        assets: 30_000_000,
    };
    assert_eq!(lens(batch::plan(&[small, huge, small])), [1, 1, 1]);
    assert_eq!(batch::plan(&[]), Vec::<std::ops::Range<usize>>::new());
    assert_eq!(batch::halve(4..9), [4..7, 7..9]);
}

// Staging.

#[test]
fn staged_assets_live_in_the_data_folder_and_are_swept() {
    let dir = tempfile::tempdir().unwrap();
    let staging = Staging::new(&dir.path().join(super::staging::DIR));
    let a = staging.stage(b"sealed").unwrap();
    let b = staging.stage(b"sealed too").unwrap();
    assert!(a.starts_with(dir.path().join("sync-assets")));
    assert_eq!(std::fs::read(&a).unwrap(), b"sealed");
    staging.remove(std::slice::from_ref(&a));
    assert!(!a.exists() && b.exists());
    staging.sweep();
    assert_eq!(staging.files(), 0);
    let outside = dir.path().join("keep");
    std::fs::write(&outside, b"x").unwrap();
    staging.remove(std::slice::from_ref(&outside));
    assert!(
        outside.exists(),
        "only the staging folder's files are removed"
    );
}

// The transport against the fake.

#[test]
fn a_build_without_the_container_reports_unavailable_and_never_touches_cloudkit() {
    let vault = Arc::new(Vault::generate().unwrap());
    let kit = Arc::new(Fake::new().without_entitlement());
    let mut device = device(&kit, &vault);
    assert_eq!(device.connect(false), Err("E_SYNC_CLOUDKIT_UNAVAILABLE"));
    assert_eq!(kit.calls(Op::Account), 0);
}

#[test]
fn the_account_status_stops_or_retries() {
    let (kit, vault) = setup();
    let mut device = device(&kit, &vault);
    for (account, code) in [
        (Account::Missing, "E_SYNC_ICLOUD_SIGNED_OUT"),
        (Account::Restricted, "E_SYNC_ICLOUD_RESTRICTED"),
        (
            Account::TemporarilyUnavailable,
            "E_SYNC_ICLOUD_ACCOUNT_UNAVAILABLE",
        ),
        (
            Account::CouldNotDetermine,
            "E_SYNC_ICLOUD_ACCOUNT_UNAVAILABLE",
        ),
    ] {
        kit.set_account(account);
        assert_eq!(device.connect(false), Err(code));
    }
    kit.set_account(Account::Available);
    kit.fail_next(Op::Account, ck(code::NETWORK_UNAVAILABLE));
    assert_eq!(device.connect(false), Err("E_SYNC_OFFLINE"));
    assert!(device.connect(false).is_ok());
}

#[test]
fn the_first_connect_makes_the_zones_the_epoch_and_the_subscriptions() {
    let (kit, vault) = setup();
    let mut a = device(&kit, &vault);
    let welcome = a.connect(false).unwrap();
    let zone = vault_zone(&vault.id().to_string());
    assert!(kit.zone_exists(ZONE_DEVOT) && kit.zone_exists(&zone) && kit.zone_exists(ZONE_CLOCK));
    let clock = kit.record(ZONE_CLOCK, &a.state.device).unwrap();
    assert_eq!(Some(welcome.time), clock.modified, "the server's clock");
    assert_eq!(welcome.device, a.state.device);
    assert_eq!((welcome.quota, welcome.attachments), ("off", "on"));
    assert!(!welcome.epoch.is_empty());
    let mut subscribed = kit.subscriptions();
    subscribed.sort();
    assert_eq!(subscribed, [ZONE_DEVOT.to_string(), zone.clone()]);
    assert!(a.state.subscribed && a.state.zone_seen && !a.state.account.is_empty());

    let mut b = device(&kit, &vault);
    assert_eq!(b.connect(false).unwrap().epoch, welcome.epoch, "one epoch");
    assert_eq!(a.connect(true).unwrap().epoch, welcome.epoch);
    assert_eq!(kit.calls(Op::Subscribe), 4, "two zones, once per device");
}

#[test]
fn the_device_row_is_saved_on_a_new_day_or_name_only() {
    let (kit, vault) = setup();
    let mut a = device(&kit, &vault);
    a.connect(false).unwrap();
    let row = format!("device-{}-{}", vault.id(), a.state.device);
    let first = kit.record(ZONE_DEVOT, &row).unwrap();
    let sealed = first.bytes("name").unwrap();
    assert_eq!(
        open_device_name(&vault, &a.state.device, sealed).unwrap(),
        (NAME.to_string(), String::new())
    );
    assert!(!sealed.windows(NAME.len()).any(|w| w == NAME.as_bytes()));
    let saves = kit.calls(Op::Save);
    a.connect(true).unwrap();
    assert_eq!(kit.calls(Op::Save), saves + 1, "only the clock");
    kit.advance(86_400_000);
    a.connect(true).unwrap();
    assert_eq!(kit.calls(Op::Save), saves + 3, "the clock and the row");
    let renamed = a.icloud.connect(&a.state, true, "Desk Mac", NOW).unwrap().1;
    assert_ne!(renamed.device_name, a.state.device_name);
}

#[test]
fn the_relay_device_id_is_sealed_in_the_name_and_adds_no_field() {
    let (kit, vault) = setup();
    let mut a = device(&kit, &vault);
    a.connect(false).unwrap();
    let before = a.state.device_name.clone();
    a.state.relay_device = "relay-device-7".into();
    let saves = kit.calls(Op::Save);
    a.connect(true).unwrap();
    assert_eq!(kit.calls(Op::Save), saves + 2, "the clock and the row");
    assert_ne!(a.state.device_name, before);

    let row = kit
        .record(
            ZONE_DEVOT,
            &format!("device-{}-{}", vault.id(), a.state.device),
        )
        .unwrap();
    let mut fields: Vec<_> = row.fields.iter().map(|(key, _)| key.as_str()).collect();
    fields.sort_unstable();
    assert_eq!(fields, ["day", "device", "name"]);
    let sealed = row.bytes("name").unwrap();
    assert_eq!(
        open_device_name(&vault, &a.state.device, sealed).unwrap(),
        (NAME.to_string(), "relay-device-7".to_string())
    );
    assert!(!sealed.windows(14).any(|w| w == b"relay-device-7"));
    // A build that knows only the name alone cannot open it, so it leaves the row out.
    assert!(vault.decrypt_record(&a.state.device, 1, &[sealed]).is_err());
}

#[test]
fn records_go_up_and_come_down_with_opaque_cursors_and_tags() {
    let (kit, vault) = setup();
    let mut a = device(&kit, &vault);
    let mut b = device(&kit, &vault);
    a.connect(false).unwrap();
    b.connect(false).unwrap();
    let big = vec![9; 2_500_000];
    let results = a.icloud.push_many(
        &[
            Item {
                id: &id(1),
                base: 0,
                tag: "",
                plaintext: b"one",
                kind: "record",
            },
            Item {
                id: &id(2),
                base: 0,
                tag: "",
                plaintext: &big,
                kind: "file",
            },
        ],
        NOW,
    );
    assert!(matches!(&results[0], PushAnswer::Pushed { version: 1, tag } if !tag.is_empty()));
    assert!(matches!(&results[1], PushAnswer::Pushed { version: 1, .. }));
    assert_eq!(kit.assets_read(), 2, "two chunks uploaded from files");
    assert_eq!(a.staging.files(), 0, "the staging folder is emptied");

    let (pulled, cursor) = b.pull_all("");
    assert_eq!(pulled.len(), 2);
    assert_eq!(pulled[0].0, id(1));
    assert_eq!(pulled[0].3, b"one");
    assert_eq!(pulled[0].2, pushed_tag(&results[0]));
    assert_eq!(pulled[1].3, big);
    assert!(STANDARD.decode(&cursor).is_ok() && !cursor.is_empty());
    assert_eq!(b.pull_all(&cursor).0.len(), 0, "the cursor moved past them");
    assert_eq!(
        b.icloud.pull("not base64!").err(),
        Some("E_SYNC_CURSOR_INVALID")
    );
}

#[test]
fn a_pull_comes_in_pages() {
    let (kit, vault) = setup();
    let mut a = device(&kit, &vault);
    a.connect(false).unwrap();
    let ids: Vec<String> = (0..60).map(id).collect();
    let items: Vec<Item<'_>> = ids
        .iter()
        .map(|id| Item {
            id,
            base: 0,
            tag: "",
            plaintext: b"x",
            kind: "record",
        })
        .collect();
    assert!(
        a.icloud
            .push_many(&items, NOW)
            .iter()
            .all(|r| matches!(r, PushAnswer::Pushed { .. }))
    );
    let first = a.icloud.pull("").unwrap();
    assert_eq!(first.records.len(), super::transport::PULL_LIMIT);
    assert!(first.more);
    assert_eq!(a.pull_all("").0.len(), 60);
}

#[test]
fn compare_and_swap_rejects_with_the_server_tag_and_the_retry_with_it_wins() {
    let (kit, vault) = setup();
    let mut a = device(&kit, &vault);
    let mut b = device(&kit, &vault);
    a.connect(false).unwrap();
    b.connect(false).unwrap();
    let first = a.push(&id(1), 0, "", b"from a");
    let tag_a = pushed_tag(&first);
    let PushAnswer::Rejected { version, tag } = b.push(&id(1), 0, "", b"from b") else {
        panic!("a second create is refused");
    };
    assert_eq!((version, tag.as_str()), (1, tag_a.as_str()));
    let merged = b.push(&id(1), version, &tag, b"merged");
    assert!(matches!(merged, PushAnswer::Pushed { version: 2, .. }));
    let PushAnswer::Rejected { version, .. } = a.push(&id(1), 1, &tag_a, b"stale") else {
        panic!("a stale tag is refused");
    };
    assert_eq!(version, 2);
    let (pulled, _) = a.pull_all("");
    assert_eq!(
        (pulled[0].1, pulled[0].3.as_slice()),
        (2, b"merged".as_slice())
    );
}

#[test]
fn a_record_that_shrank_keeps_no_old_chunk() {
    let (kit, vault) = setup();
    let mut a = device(&kit, &vault);
    a.connect(false).unwrap();
    let tag = pushed_tag(&a.push(&id(1), 0, "", &vec![1; 2_000_000]));
    let zone = vault_zone(&vault.id().to_string());
    assert!(
        kit.record(&zone, &vault.store_name(&id(1)))
            .unwrap()
            .get("chunk1")
            .is_some()
    );
    a.push(&id(1), 1, &tag, b"small now");
    let stored = kit.record(&zone, &vault.store_name(&id(1))).unwrap();
    assert!(stored.get("chunk0").is_none() && stored.get("chunk1").is_none());
    assert_eq!(a.pull_all("").0[0].3, b"small now");
}

#[test]
fn an_expired_token_pulls_again_from_the_start() {
    let (kit, vault) = setup();
    let mut a = device(&kit, &vault);
    a.connect(false).unwrap();
    a.push(&id(1), 0, "", b"one");
    let (_, cursor) = a.pull_all("");
    kit.expire_tokens(&vault_zone(&vault.id().to_string()));
    let page = a.icloud.pull(&cursor).unwrap();
    assert_eq!(page.records.len(), 1, "from the start");
    assert_ne!(page.next, cursor);
}

#[test]
fn a_deleted_zone_stops_a_vault_that_synced_and_is_made_again_for_one_that_never_did() {
    let (kit, vault) = setup();
    let zone = vault_zone(&vault.id().to_string());
    let mut a = device(&kit, &vault);
    let epoch = a.connect(false).unwrap().epoch;
    a.push(&id(1), 0, "", b"one");
    kit.delete_zone(&zone);
    assert_eq!(a.icloud.pull("").err(), Some("E_SYNC_ICLOUD_ZONE_MISSING"));
    let ids: Vec<String> = (2..252).map(id).collect();
    let items: Vec<Item<'_>> = ids
        .iter()
        .map(|id| Item {
            id,
            base: 0,
            tag: "",
            plaintext: b"two",
            kind: "record",
        })
        .collect();
    let saves = kit.calls(Op::Save);
    let results = a.icloud.push_many(&items, NOW);
    assert!(
        results
            .iter()
            .all(|r| *r == PushAnswer::Failed("E_SYNC_ICLOUD_ZONE_MISSING"))
    );
    assert_eq!(
        kit.calls(Op::Save),
        saves + 1,
        "the second batch is not sent"
    );
    let saves = kit.calls(Op::Save);
    assert_eq!(a.connect(true), Err("E_SYNC_ICLOUD_DELETED"));
    assert_eq!(kit.calls(Op::Save), saves, "nothing uploaded");
    assert!(!kit.zone_exists(&zone), "nor made again");

    // A library that never synced makes the zone again, under a new epoch.
    let again = a.connect(false).unwrap();
    assert!(kit.zone_exists(&zone));
    assert_ne!(again.epoch, epoch);
    assert!(a.state.subscribed);

    // As does Settings' "upload again", which forgets the zone was seen.
    kit.delete_zone(&zone);
    a.state.zone_seen = false;
    let third = a.connect(true).unwrap();
    assert_ne!(third.epoch, again.epoch);
}

#[test]
fn a_first_connect_takes_the_epoch_another_device_just_saved() {
    let (kit, vault) = setup();
    let zone = vault_zone(&vault.id().to_string());
    let mut a = device(&kit, &vault);
    let epoch = a.connect(false).unwrap().epoch;
    // b found the zone missing before a made it, and reads the epoch a saved since.
    kit.delete_zone(&zone);
    let mut b = device(&kit, &vault);
    assert_eq!(b.connect(false).unwrap().epoch, epoch);
}

#[test]
fn a_vault_zone_gone_is_made_again_only_while_current_names_the_vault() {
    let (kit, vault) = setup();
    let zone = vault_zone(&vault.id().to_string());
    // Joined and connected, but never pushed or pulled; then the vault was left elsewhere.
    let mut phone = device(&kit, &vault);
    phone.connect(false).unwrap();
    kit.delete_zone(&zone);
    kit.delete_zone(ZONE_DEVOT);
    kit.delete_zone(ZONE_CLOCK);
    let (saves, zones) = (kit.calls(Op::Save), kit.calls(Op::SaveZones));
    assert_eq!(phone.connect(false), Err("E_SYNC_ICLOUD_DELETED"));
    // A device that joined while the vault was being left never saw the zone.
    let mut joiner = device(&kit, &vault);
    assert_eq!(joiner.connect(false), Err("E_SYNC_ICLOUD_DELETED"));
    assert_eq!(kit.calls(Op::Save), saves, "nothing uploaded");
    assert_eq!(kit.calls(Op::SaveZones), zones, "no zone made again");

    let other = Vault::generate().unwrap().id().to_string();
    super::current::claim(kit.as_ref(), &other).unwrap();
    assert_eq!(phone.connect(false), Err("E_SYNC_ICLOUD_DELETED"));
    assert!(!kit.zone_exists(&zone));
}

#[test]
fn a_leave_that_stopped_after_current_s_zone_stops_every_device() {
    let (kit, vault) = setup();
    let zone = vault_zone(&vault.id().to_string());
    let mut phone = device(&kit, &vault);
    phone.connect(false).unwrap();
    kit.delete_zone(ZONE_DEVOT);
    let (saves, zones) = (kit.calls(Op::Save), kit.calls(Op::SaveZones));
    assert_eq!(phone.connect(false), Err("E_SYNC_ICLOUD_DELETED"));
    let mut joiner = device(&kit, &vault);
    assert_eq!(joiner.connect(false), Err("E_SYNC_ICLOUD_DELETED"));
    assert_eq!(kit.calls(Op::Save), saves, "nothing uploaded");
    assert_eq!(kit.calls(Op::SaveZones), zones, "no zone made again");
    assert!(!kit.zone_exists(ZONE_DEVOT));
    assert!(kit.zone_exists(&zone));
}

#[test]
fn the_account_is_kept_as_a_short_hash_of_the_user_record() {
    use sha2::{Digest, Sha256};
    let (kit, vault) = setup();
    let mut a = device(&kit, &vault);
    a.connect(false).unwrap();
    let digest = Sha256::new()
        .chain_update(b"devot/icloud/account/v1")
        .chain_update(b"_user-one")
        .finalize();
    let expected: String = digest[..16].iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(a.state.account, expected);
    assert!(!a.state.account.contains("user"));
}

#[test]
fn a_pause_is_reported_on_the_server_clock() {
    let (kit, vault) = setup();
    let mut a = device(&kit, &vault);
    kit.advance(90_000);
    let welcome = a.connect(false).unwrap();
    kit.fail_next(
        Op::Save,
        CkError {
            code: code::REQUEST_RATE_LIMITED,
            retry_after_ms: Some(12_000),
            server_record: None,
        },
    );
    assert_eq!(
        a.push(&id(1), 0, "", b"x"),
        PushAnswer::Paused {
            until: Some(welcome.time + 12_000),
            code: "E_SYNC_ICLOUD_BUSY"
        }
    );
}

#[test]
fn a_tag_that_is_not_a_record_archive_fails_alone() {
    let (kit, vault) = setup();
    let mut a = device(&kit, &vault);
    a.connect(false).unwrap();
    let garbage = STANDARD.encode(b"not an archive");
    let results = a.icloud.push_many(
        &[
            Item {
                id: &id(1),
                base: 1,
                tag: &garbage,
                plaintext: b"x",
                kind: "record",
            },
            Item {
                id: &id(2),
                base: 0,
                tag: "",
                plaintext: b"fine",
                kind: "record",
            },
        ],
        NOW,
    );
    assert_eq!(results[0], PushAnswer::Failed("E_SYNC_TAG_INVALID"));
    assert!(matches!(results[1], PushAnswer::Pushed { .. }));
}

#[test]
fn a_zone_missing_on_a_device_that_never_saw_it_is_made() {
    let (kit, vault) = setup();
    let mut a = device(&kit, &vault);
    // A library that synced on a relay and moves its vault to iCloud.
    assert!(a.connect(true).is_ok());
}

#[test]
fn two_devices_making_the_zone_again_at_once_end_with_one_epoch() {
    let (kit, vault) = setup();
    let zone = vault_zone(&vault.id().to_string());
    let mut a = device(&kit, &vault);
    let mut b = device(&kit, &vault);
    a.connect(false).unwrap();
    b.connect(false).unwrap();
    kit.delete_zone(&zone);
    a.state.zone_seen = false;
    b.state.zone_seen = false;
    let renewed = a.connect(true).unwrap().epoch;
    let name = format!("meta-{}", vault.id());
    let meta = kit.record(ZONE_DEVOT, &name).unwrap();
    assert_eq!(meta.text("epoch"), Some(renewed.as_str()));
    // b read the old epoch before a saved its new one: its save is refused, and it takes a's.
    kit.delete_zone(&zone);
    kit.fail_record(
        &name,
        CkError {
            code: code::SERVER_RECORD_CHANGED,
            retry_after_ms: None,
            server_record: Some(Box::new(meta)),
        },
    );
    assert_eq!(b.connect(true).unwrap().epoch, renewed);
}

#[test]
fn another_apple_id_stops_sync_and_uploads_nothing() {
    let (kit, vault) = setup();
    let mut a = device(&kit, &vault);
    a.connect(false).unwrap();
    kit.switch_user("_user-two");
    let saves = kit.calls(Op::Save);
    assert_eq!(a.connect(true), Err("E_SYNC_ICLOUD_ACCOUNT_CHANGED"));
    assert_eq!(kit.calls(Op::Save), saves);
    kit.switch_user("_user-one");
    assert!(a.connect(true).is_ok(), "the first Apple ID is back");
}

#[test]
fn a_full_icloud_pauses_without_an_end_and_the_rest_still_goes() {
    let (kit, vault) = setup();
    let mut a = device(&kit, &vault);
    a.connect(false).unwrap();
    kit.fail_record(&vault.store_name(&id(1)), ck(code::QUOTA_EXCEEDED));
    let results = a.icloud.push_many(
        &[
            Item {
                id: &id(1),
                base: 0,
                tag: "",
                plaintext: b"big",
                kind: "record",
            },
            Item {
                id: &id(2),
                base: 0,
                tag: "",
                plaintext: b"tombstone",
                kind: "record",
            },
        ],
        NOW,
    );
    assert_eq!(
        results[0],
        PushAnswer::Paused {
            until: None,
            code: "E_SYNC_ICLOUD_FULL"
        }
    );
    assert!(matches!(results[1], PushAnswer::Pushed { .. }));
}

#[test]
fn rate_limits_pause_for_the_wait_cloudkit_asks_and_end_the_pass() {
    let (kit, vault) = setup();
    let mut a = device(&kit, &vault);
    let server = a.connect(false).unwrap().time;
    kit.fail_next(
        Op::Save,
        CkError {
            code: code::REQUEST_RATE_LIMITED,
            retry_after_ms: Some(12_000),
            server_record: None,
        },
    );
    let ids: Vec<String> = (0..250).map(id).collect();
    let items: Vec<Item<'_>> = ids
        .iter()
        .map(|id| Item {
            id,
            base: 0,
            tag: "",
            plaintext: b"x",
            kind: "record",
        })
        .collect();
    let saves = kit.calls(Op::Save);
    let results = a.icloud.push_many(&items, NOW);
    let paused = PushAnswer::Paused {
        until: Some(server + 12_000),
        code: "E_SYNC_ICLOUD_BUSY",
    };
    assert!(results.iter().all(|r| *r == paused));
    assert_eq!(
        kit.calls(Op::Save),
        saves + 1,
        "the second batch is not sent"
    );

    kit.fail_record(
        &vault.store_name(&id(0)),
        CkError {
            code: code::ZONE_BUSY,
            retry_after_ms: None,
            server_record: None,
        },
    );
    let results = a.icloud.push_many(&items[..1], NOW);
    assert_eq!(
        results[0],
        PushAnswer::Paused {
            until: Some(server + error::DEFAULT_RETRY_MS as i64),
            code: "E_SYNC_ICLOUD_BUSY"
        }
    );
}

#[test]
fn limit_exceeded_halves_the_batch() {
    let (kit, vault) = setup();
    let mut a = device(&kit, &vault);
    a.connect(false).unwrap();
    kit.limit(3);
    let ids: Vec<String> = (0..8).map(id).collect();
    let items: Vec<Item<'_>> = ids
        .iter()
        .map(|id| Item {
            id,
            base: 0,
            tag: "",
            plaintext: b"x",
            kind: "record",
        })
        .collect();
    let before = kit.saved_sizes().len();
    let results = a.icloud.push_many(&items, NOW);
    assert!(
        results
            .iter()
            .all(|r| matches!(r, PushAnswer::Pushed { .. }))
    );
    assert_eq!(kit.saved_sizes()[before..], [2, 2, 2, 2]);
    kit.limit(0);
    assert_eq!(
        a.icloud.push_many(&items[..1], NOW)[0],
        PushAnswer::Failed("E_SYNC_TOO_LARGE")
    );
}

#[test]
fn an_item_its_batch_failed_for_is_sent_again_once() {
    let (kit, vault) = setup();
    let mut a = device(&kit, &vault);
    a.connect(false).unwrap();
    kit.fail_record(&vault.store_name(&id(1)), ck(code::BATCH_REQUEST_FAILED));
    assert!(matches!(
        a.push(&id(1), 0, "", b"x"),
        PushAnswer::Pushed { .. }
    ));
    kit.fail_record(&vault.store_name(&id(2)), ck(code::BATCH_REQUEST_FAILED));
    kit.fail_record(&vault.store_name(&id(2)), ck(code::BATCH_REQUEST_FAILED));
    assert_eq!(
        a.push(&id(2), 0, "", b"x"),
        PushAnswer::Failed("E_SYNC_OFFLINE")
    );
}

#[test]
fn an_unreadable_tag_or_a_record_past_sixteen_chunks_fails_alone() {
    let (kit, vault) = setup();
    let mut a = device(&kit, &vault);
    a.connect(false).unwrap();
    let huge = vec![0; 17 * 1_900_000];
    let results = a.icloud.push_many(
        &[
            Item {
                id: &id(1),
                base: 1,
                tag: "%%",
                plaintext: b"x",
                kind: "record",
            },
            Item {
                id: &id(2),
                base: 0,
                tag: "",
                plaintext: &huge,
                kind: "file",
            },
            Item {
                id: &id(3),
                base: 0,
                tag: "",
                plaintext: b"fine",
                kind: "record",
            },
        ],
        NOW,
    );
    assert_eq!(results[0], PushAnswer::Failed("E_SYNC_TAG_INVALID"));
    assert_eq!(results[1], PushAnswer::Failed("E_SYNC_TOO_LARGE"));
    assert!(matches!(results[2], PushAnswer::Pushed { .. }));
    assert_eq!(a.staging.files(), 0);
}

#[test]
fn an_offline_save_fails_its_batch_and_the_rest() {
    let (kit, vault) = setup();
    let mut a = device(&kit, &vault);
    a.connect(false).unwrap();
    kit.fail_next(Op::Save, ck(code::NETWORK_FAILURE));
    let results = a.icloud.push_many(
        &[
            Item {
                id: &id(1),
                base: 0,
                tag: "",
                plaintext: b"x",
                kind: "record",
            },
            Item {
                id: &id(2),
                base: 0,
                tag: "",
                plaintext: b"y",
                kind: "record",
            },
        ],
        NOW,
    );
    assert!(
        results
            .iter()
            .all(|r| *r == PushAnswer::Failed("E_SYNC_OFFLINE"))
    );
}

#[test]
fn a_record_that_does_not_open_comes_down_with_its_code() {
    let (kit, vault) = setup();
    let mut a = device(&kit, &vault);
    a.connect(false).unwrap();
    let other = Arc::new(Vault::generate().unwrap());
    // Another vault's key sealed it: the chunks do not open here.
    let (name, chunks) = other.seal_stored(&id(1), 1, b"x").unwrap();
    let (record, _) =
        encoding::encode(&name, None, 1, "record", &chunks, &mut |_| unreachable!()).unwrap();
    use super::CloudKit as _;
    kit.save(
        &vault_zone(&vault.id().to_string()),
        &[record],
        super::kit::SavePolicy::IfUnchanged,
    )
    .unwrap();
    let page = a.icloud.pull("").unwrap();
    assert_eq!(
        page.records[0].plaintext.as_ref().err(),
        Some(&"E_SYNC_CHUNK_AUTH")
    );
    assert_eq!(
        (page.records[0].id.as_str(), page.records[0].version),
        (name.as_str(), 1)
    );
    assert_eq!(page.records[0].name, name);
}

#[test]
fn records_go_up_under_store_names_and_ones_filed_under_their_ids_are_left() {
    let (kit, vault) = setup();
    let mut a = device(&kit, &vault);
    a.connect(false).unwrap();
    a.push(&id(1), 0, "", b"a note");
    let zone = vault_zone(&vault.id().to_string());
    assert!(kit.record(&zone, &id(1)).is_none());
    let stored = kit.record(&zone, &vault.store_name(&id(1))).unwrap();
    assert!(!format!("{stored:?}").contains(&id(1)));

    // A build before store names filed this one under its ID.
    let chunks = vault.encrypt_record(&id(2), 1, b"older").unwrap();
    let (record, _) =
        encoding::encode(&id(2), None, 1, "record", &chunks, &mut |_| unreachable!()).unwrap();
    use super::CloudKit as _;
    kit.save(&zone, &[record], super::kit::SavePolicy::IfUnchanged)
        .unwrap();
    let (pulled, _) = a.pull_all("");
    let seen: Vec<(&str, &[u8])> = pulled
        .iter()
        .map(|(id, _, _, plaintext)| (id.as_str(), plaintext.as_slice()))
        .collect();
    assert_eq!(seen, [(id(1).as_str(), &b"a note"[..])]);
}
