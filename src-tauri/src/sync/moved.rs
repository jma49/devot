//! The moved marker (docs/adr/0015-sync-through-icloud-with-devots-own-encryption.md), as
//! `src/core/sync/moved.ts` reads it: an ordinary record under a reserved ID, framed as every record
//! is (format, header length as a big-endian u32, JSON header), whose header names the transport
//! the vault went to. The device that switches leaves it on the relay before it leaves.

use super::Vault;
use super::client::{self, Connection, PushReply};

/// A valid UUIDv7 whose time is 0, so no device ever makes it for a note.
pub(crate) const MOVED_ID: &str = "00000000-0000-7000-8000-000000000000";
const RECORD_FORMAT: u8 = 1;
const TRIES: usize = 5;
pub(crate) const REFUSED: &str = "E_SYNC_MOVED_REFUSED";

pub(crate) fn body(to: &str) -> Vec<u8> {
    let head = format!(r#"{{"id":"{MOVED_ID}","kind":"moved","to":"{to}"}}"#);
    let mut out = Vec::with_capacity(5 + head.len());
    out.push(RECORD_FORMAT);
    out.extend_from_slice(&u32::try_from(head.len()).unwrap_or(u32::MAX).to_be_bytes());
    out.extend_from_slice(head.as_bytes());
    out
}

/// Leaves the marker naming iCloud on the relay; one already there is written over, as its body
/// needs no merge.
pub(crate) fn leave_relay(connection: &Connection, vault: &Vault) -> Result<(), &'static str> {
    let body = body("icloud");
    let mut base = 0;
    for _ in 0..TRIES {
        match client::push(connection, vault, MOVED_ID, base, &body, "record")? {
            PushReply::Pushed { .. } => return Ok(()),
            PushReply::Rejected { version } => base = version,
            PushReply::Full | PushReply::Paused { .. } => return Err(REFUSED),
        }
    }
    Err(REFUSED)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_the_marker_as_the_core_reads_it() {
        let head = br#"{"id":"00000000-0000-7000-8000-000000000000","kind":"moved","to":"icloud"}"#;
        let mut expected = vec![1, 0, 0, 0, u8::try_from(head.len()).unwrap()];
        expected.extend_from_slice(head);
        assert_eq!(body("icloud"), expected);
    }
}
