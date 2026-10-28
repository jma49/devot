//! Attachments (docs/adr/0003-sync-attachments-as-records.md) through the service and the client
//! against the Node relay: a multi-chunk image, and what Rust refuses on the way in and out.

use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::json;

use super::client::{self, Connection, PushReply};
use super::relay_tests::{NodeRelay, SECRET, Secrets, events, service_on};
use super::service::PushDto;
use super::{MAX_CHUNK_BYTES, Vault, chunk_count};
use crate::commands::files::MAX_FILE_BYTES;

const FILE: &str = "0192f4c8-7a1b-7c3d-8e9f-0123456789a1";
const NOTE: &str = "0192f4c8-7a1b-7c3d-8e9f-0123456789a2";

fn png(len: usize) -> Vec<u8> {
    let mut bytes: Vec<u8> = (0..len).map(|i| (i * 31 % 251) as u8).collect();
    bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
    bytes
}

fn envelope(id: &str, mime: &str, data: &[u8]) -> Vec<u8> {
    let head = serde_json::to_vec(&json!({
        "kind": "file", "id": id, "purged": false, "noteId": NOTE, "noteHlc": "",
        "name": "shot.png", "mime": mime, "size": data.len(), "createdAt": 1_728_000_000_000_i64
    }))
    .unwrap();
    let mut out = vec![1u8];
    out.extend((head.len() as u32).to_be_bytes());
    out.extend(head);
    out.extend(data);
    out
}

fn b64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

#[test]
fn moves_a_ten_mib_image_through_the_relay_in_six_chunks_and_opens_it_whole() {
    let relay = NodeRelay::start();
    let vault = Vault::create(&Secrets::default()).unwrap();
    let mac = client::create_vault(&relay.url, SECRET, &vault, "mac").unwrap();
    let (on_event, _) = events();
    let (socket, welcome) =
        Connection::open(&relay.url, &vault.id().to_string(), &mac.token, on_event).unwrap();
    assert_eq!(welcome.attachments, Some("on"));
    let record = envelope(FILE, "image/png", &png(MAX_FILE_BYTES));
    assert_eq!(chunk_count(record.len()), 6);
    assert!(record.len() > 5 * MAX_CHUNK_BYTES);
    assert_eq!(
        client::push(&socket, &vault, FILE, 0, &record, "file"),
        Ok(PushReply::Pushed { version: 1, seq: 1 })
    );
    let page = client::pull(&socket, &vault, 0).unwrap();
    let pulled = &page.records[0];
    assert_eq!((pulled.id.as_str(), pulled.kind.as_str()), (FILE, "file"));
    assert_eq!(
        pulled.plaintext.as_deref().map(|p| p.as_slice()),
        Ok(&record[..])
    );
    socket.close();
}

#[test]
fn checks_an_attachment_as_a_paste_on_the_way_in_and_on_the_way_out() {
    let relay = NodeRelay::start();
    let dir = tempfile::tempdir().unwrap();
    let secrets: Arc<Secrets> = Arc::default();
    let service = service_on(&relay, dir.path(), secrets.clone());
    service.create_vault(SECRET).unwrap();
    service.recovery_saved().unwrap();
    let welcome = service.connect().unwrap();
    assert_eq!(welcome.attachments, Some("on"));

    let image = envelope(FILE, "image/png", &png(5000));
    assert!(matches!(
        service.push(FILE, 0, &b64(&image), "file"),
        Ok(PushDto::Pushed { version: 1, .. })
    ));
    let page = service.pull(welcome.seq).unwrap();
    assert_eq!(page.records.len(), 1);
    assert_eq!(page.records[0].kind, "file");
    assert_eq!(page.records[0].data.as_deref(), Some(b64(&image).as_str()));
    assert_eq!(page.records[0].error, None);

    // Nothing that a paste refuses leaves this device ...
    let svg = envelope(
        "0192f4c8-7a1b-7c3d-8e9f-0123456789b1",
        "image/svg+xml",
        b"<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>",
    );
    assert_eq!(
        service.push(
            "0192f4c8-7a1b-7c3d-8e9f-0123456789b1",
            0,
            &b64(&svg),
            "file"
        ),
        Err("E_FILE_TYPE_REFUSED")
    );
    let big = envelope(
        "0192f4c8-7a1b-7c3d-8e9f-0123456789b2",
        "image/png",
        &png(MAX_FILE_BYTES + 1),
    );
    assert_eq!(
        service.push(
            "0192f4c8-7a1b-7c3d-8e9f-0123456789b2",
            0,
            &b64(&big),
            "file"
        ),
        Err("E_FILE_SIZE_INVALID")
    );
    assert_eq!(
        service.push(FILE, 1, &b64(&image), "folder"),
        Err("E_SYNC_KIND_INVALID")
    );
    assert!(service.pull(page.next).unwrap().records.is_empty());

    // ... and nothing a device with the key sends past that check is handed to the web view.
    let vault = Vault::load(secrets.as_ref()).unwrap().unwrap();
    let mac = client::enroll(&relay.url, &vault, "rogue").unwrap();
    let (on_event, _) = events();
    let (rogue, _) =
        Connection::open(&relay.url, &vault.id().to_string(), &mac.token, on_event).unwrap();
    let rogue_id = "0192f4c8-7a1b-7c3d-8e9f-0123456789c1";
    for (id, record) in [
        (
            rogue_id,
            envelope(rogue_id, "image/svg+xml", b"<svg xmlns='x'/>"),
        ),
        (
            "0192f4c8-7a1b-7c3d-8e9f-0123456789c2",
            envelope(
                "0192f4c8-7a1b-7c3d-8e9f-0123456789c2",
                "image/png",
                &png(MAX_FILE_BYTES + 1),
            ),
        ),
        (
            "0192f4c8-7a1b-7c3d-8e9f-0123456789c3",
            envelope(FILE, "image/png", &png(100)),
        ),
    ] {
        assert!(matches!(
            client::push(&rogue, &vault, id, 0, &record, "file"),
            Ok(PushReply::Pushed { .. })
        ));
    }
    let page = service.pull(page.next).unwrap();
    assert_eq!(page.records.len(), 3);
    let errors: Vec<_> = page.records.iter().map(|r| r.error).collect();
    assert_eq!(
        errors,
        [
            Some("E_FILE_TYPE_REFUSED"),
            Some("E_FILE_SIZE_INVALID"),
            Some("E_SYNC_RECORD_INVALID"),
        ]
    );
    assert!(page.records.iter().all(|r| r.data.is_none()));
    rogue.close();
    service.disconnect();
}
