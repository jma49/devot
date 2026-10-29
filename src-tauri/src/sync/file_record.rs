//! A file record's plaintext (docs/adr/0003-sync-attachments-as-records.md, src/core/sync/records.ts):
//! `format (1) || header length (u32, big-endian) || JSON header || bytes`. It is checked as a paste
//! is (`commands::files::validate_upload`): the bytes must be a known raster image of at most
//! 10 MiB whose type and size the header names. Rust checks every file record that arrives, before
//! the web view sees it, and every one that leaves, before it is sealed.

use serde::Deserialize;

use crate::commands::files::{MAX_FILE_BYTES, Upload, detect_image, validate_upload};
use crate::commands::notes::{valid_hlc, valid_note_id};

const FORMAT: u8 = 1;
const MAX_HEADER_BYTES: usize = 4096;

/// The largest file record's plaintext: the largest image and its header.
pub(crate) const MAX_FILE_RECORD_BYTES: usize = MAX_FILE_BYTES + MAX_HEADER_BYTES + 5;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Header {
    kind: String,
    id: String,
    purged: bool,
    note_id: String,
    note_hlc: String,
    name: String,
    mime: String,
    size: u64,
    created_at: i64,
}

/// The fields of a live file as another device wrote them.
pub(crate) struct Fields<'a> {
    pub id: &'a str,
    pub note_id: &'a str,
    pub note_hlc: &'a str,
    pub name: &'a str,
    pub mime: &'a str,
    pub size: u64,
    pub created_at: i64,
}

const INVALID: &str = "E_SYNC_RECORD_INVALID";

/// Checks a live file's fields against its bytes. The codes are a paste's (`E_FILE_*`), or
/// `E_SYNC_RECORD_INVALID` for fields that do not describe the bytes.
pub(crate) fn check_file(fields: &Fields<'_>, data: &[u8]) -> Result<(), &'static str> {
    let mime = validate_upload(
        &Upload {
            id: fields.id.into(),
            note_id: fields.note_id.into(),
            name: fields.name.into(),
        },
        data,
    )?;
    let named = detect_image(data) == Some(fields.mime) && mime == fields.mime;
    let hlc_ok = fields.note_hlc.is_empty() || valid_hlc(fields.note_hlc);
    if !named || !hlc_ok || fields.size != data.len() as u64 || fields.created_at < 0 {
        return Err(INVALID);
    }
    Ok(())
}

/// Checks the plaintext of the file record `id`: its layout, then its fields and bytes.
pub(crate) fn check(id: &str, plaintext: &[u8]) -> Result<(), &'static str> {
    if plaintext.len() > MAX_FILE_RECORD_BYTES {
        return Err("E_SYNC_TOO_LARGE");
    }
    let [format, a, b, c, d, rest @ ..] = plaintext else {
        return Err(INVALID);
    };
    let length = u32::from_be_bytes([*a, *b, *c, *d]) as usize;
    if *format != FORMAT || length > MAX_HEADER_BYTES || length > rest.len() {
        return Err(INVALID);
    }
    let (head, data) = rest.split_at(length);
    let header: Header = serde_json::from_slice(head).map_err(|_| INVALID)?;
    if header.kind != "file" || header.id != id || !valid_note_id(id) {
        return Err(INVALID);
    }
    if header.purged {
        let empty = data.is_empty()
            && header.note_id.is_empty()
            && header.note_hlc.is_empty()
            && header.name.is_empty()
            && header.mime.is_empty()
            && header.size == 0
            && header.created_at == 0;
        return if empty { Ok(()) } else { Err(INVALID) };
    }
    check_file(
        &Fields {
            id,
            note_id: &header.note_id,
            note_hlc: &header.note_hlc,
            name: &header.name,
            mime: &header.mime,
            size: header.size,
            created_at: header.created_at,
        },
        data,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    const FILE: &str = "0192a6f0-0000-7000-8000-00000000f001";
    const NOTE: &str = "0192a6f0-0000-7000-8000-000000000001";

    fn png(len: usize) -> Vec<u8> {
        let mut bytes = vec![0u8; len];
        bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        bytes
    }

    fn header(data: &[u8]) -> Value {
        json!({
            "kind": "file", "id": FILE, "purged": false, "noteId": NOTE, "noteHlc": "",
            "name": "shot.png", "mime": "image/png", "size": data.len(), "createdAt": 1_728_000_000_000_i64
        })
    }

    fn record(header: &Value, data: &[u8]) -> Vec<u8> {
        let head = serde_json::to_vec(header).unwrap();
        let mut out = vec![FORMAT];
        out.extend((head.len() as u32).to_be_bytes());
        out.extend(head);
        out.extend(data);
        out
    }

    #[test]
    fn takes_a_file_a_paste_would_take() {
        let data = png(100);
        assert_eq!(check(FILE, &record(&header(&data), &data)), Ok(()));
        let mut moved = header(&data);
        moved["noteHlc"] = json!("0001728000000001-0000-mac");
        assert_eq!(check(FILE, &record(&moved, &data)), Ok(()));
    }

    #[test]
    fn takes_a_tombstone_that_holds_nothing() {
        let gone = json!({
            "kind": "file", "id": FILE, "purged": true, "noteId": "", "noteHlc": "",
            "name": "", "mime": "", "size": 0, "createdAt": 0
        });
        assert_eq!(check(FILE, &record(&gone, &[])), Ok(()));
        assert_eq!(check(FILE, &record(&gone, &png(10))), Err(INVALID));
        let mut kept = gone.clone();
        kept["name"] = json!("kept.png");
        assert_eq!(check(FILE, &record(&kept, &[])), Err(INVALID));
    }

    #[test]
    fn refuses_what_a_paste_refuses() {
        let svg = b"<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>";
        let mut h = header(svg);
        h["mime"] = json!("image/svg+xml");
        assert_eq!(check(FILE, &record(&h, svg)), Err("E_FILE_TYPE_REFUSED"));
        let data = png(100);
        let big = png(MAX_FILE_BYTES + 1);
        assert_eq!(
            check(FILE, &record(&header(&big), &big)),
            Err("E_FILE_SIZE_INVALID")
        );
        let huge = png(MAX_FILE_RECORD_BYTES + 1);
        assert_eq!(check(FILE, &huge), Err("E_SYNC_TOO_LARGE"));
        let mut named = header(&data);
        named["name"] = json!("a\nb.png");
        assert_eq!(
            check(FILE, &record(&named, &data)),
            Err("E_FILE_NAME_INVALID")
        );
        named["name"] = json!("");
        assert_eq!(
            check(FILE, &record(&named, &data)),
            Err("E_FILE_NAME_INVALID")
        );
        assert_eq!(
            check(FILE, &record(&header(&[]), &[])),
            Err("E_FILE_SIZE_INVALID")
        );
    }

    #[test]
    fn takes_the_largest_image_and_refuses_one_byte_more() {
        let edge = png(MAX_FILE_BYTES);
        assert_eq!(check(FILE, &record(&header(&edge), &edge)), Ok(()));
        let over = png(MAX_FILE_BYTES + 1);
        assert!(check(FILE, &record(&header(&over), &over)).is_err());
    }

    #[test]
    fn refuses_fields_that_do_not_describe_the_bytes() {
        let data = png(100);
        let cases: [(&str, Value); 8] = [
            ("mime", json!("image/jpeg")),
            ("size", json!(99)),
            ("id", json!(NOTE)),
            ("noteId", json!("nope")),
            ("noteHlc", json!("\u{e9}")),
            ("createdAt", json!(-1)),
            ("kind", json!("book")),
            ("purged", json!("no")),
        ];
        for (key, value) in cases {
            let mut h = header(&data);
            h[key] = value;
            assert!(check(FILE, &record(&h, &data)).is_err(), "{key}");
        }
        assert!(check(NOTE, &record(&header(&data), &data)).is_err());
    }

    #[test]
    fn refuses_a_record_cut_short_or_in_another_format() {
        let data = png(100);
        let whole = record(&header(&data), &data);
        for cut in [0, 3, 5, 20] {
            assert!(check(FILE, &whole[..cut]).is_err(), "{cut}");
        }
        let mut other = whole.clone();
        other[0] = 2;
        assert_eq!(check(FILE, &other), Err(INVALID));
        let mut long = whole;
        long[1..5].copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(check(FILE, &long), Err(INVALID));
    }
}
