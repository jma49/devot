//! A Devot record as a `DevotRecord` (ADR 0015, Record): `version` (a counter, since a change tag
//! is not one), `kind`, `chunkCount`, and the sealed chunks either `inline` (one chunk of at most
//! [`INLINE_MAX`]) or as the assets `chunk0` to `chunk15`. Every data field is written on each
//! save, the unused ones as null, so a record that shrank keeps no chunk of an older version.

use std::path::PathBuf;

use super::error::TOO_LARGE;
use super::kit::{CkRecord, TYPE_RECORD, Value};

/// The 1 MB record limit less the other fields and CloudKit's own overhead.
pub(crate) const INLINE_MAX: usize = 700_000;
/// The relay's limit too.
pub(crate) const MAX_CHUNKS: usize = 16;
const MAX_VERSION: i64 = 9_007_199_254_740_991;
pub(crate) const INVALID: &str = "E_SYNC_ICLOUD_RECORD_INVALID";

pub(crate) const VERSION: &str = "version";
pub(crate) const KIND: &str = "kind";
pub(crate) const CHUNK_COUNT: &str = "chunkCount";
pub(crate) const INLINE: &str = "inline";

pub(crate) fn chunk_field(index: usize) -> String {
    format!("chunk{index}")
}

/// How much a record puts in a request: inline bytes, and asset bytes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Size {
    pub inline: usize,
    pub assets: usize,
}

/// `system`: the tag the record was pulled or pushed with, or `None` to create it. `stage` writes
/// a chunk to a file for upload and gives its path.
pub(crate) fn encode(
    id: &str,
    system: Option<Vec<u8>>,
    version: u64,
    kind: &str,
    chunks: &[Vec<u8>],
    stage: &mut dyn FnMut(&[u8]) -> Result<PathBuf, &'static str>,
) -> Result<(CkRecord, Size), &'static str> {
    if chunks.is_empty() {
        return Err(INVALID);
    }
    if chunks.len() > MAX_CHUNKS {
        return Err(TOO_LARGE);
    }
    let version = i64::try_from(version)
        .ok()
        .filter(|v| (1..=MAX_VERSION).contains(v))
        .ok_or(INVALID)?;
    let mut record = CkRecord::new(TYPE_RECORD, id)
        .with(VERSION, Value::Int(version))
        .with(KIND, Value::Text(kind.to_string()))
        .with(CHUNK_COUNT, Value::Int(chunks.len() as i64));
    record.system = system;
    let mut size = Size::default();
    let inline = chunks.len() == 1 && chunks[0].len() <= INLINE_MAX;
    if inline {
        size.inline = chunks[0].len();
        record.set(INLINE, Value::Bytes(chunks[0].clone()));
    } else {
        record.set(INLINE, Value::Null);
    }
    for index in 0..MAX_CHUNKS {
        let value = match chunks.get(index) {
            Some(chunk) if !inline => {
                size.assets += chunk.len();
                Value::Asset(stage(chunk)?)
            }
            _ => Value::Null,
        };
        record.set(&chunk_field(index), value);
    }
    Ok((record, size))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Decoded {
    pub version: u64,
    pub kind: String,
    pub chunks: Vec<Vec<u8>>,
}

/// The version alone, for a `serverRecordChanged`'s server record.
pub(crate) fn version_of(record: &CkRecord) -> Result<u64, &'static str> {
    record
        .int(VERSION)
        .filter(|v| (1..=MAX_VERSION).contains(v))
        .and_then(|v| u64::try_from(v).ok())
        .ok_or(INVALID)
}

pub(crate) fn decode(record: &CkRecord) -> Result<Decoded, &'static str> {
    if record.kind != TYPE_RECORD {
        return Err(INVALID);
    }
    let version = version_of(record)?;
    let kind = record.text(KIND).ok_or(INVALID)?.to_string();
    let count = record
        .int(CHUNK_COUNT)
        .and_then(|n| usize::try_from(n).ok())
        .filter(|n| (1..=MAX_CHUNKS).contains(n))
        .ok_or(INVALID)?;
    let chunks = match record.bytes(INLINE) {
        Some(inline) if count == 1 => vec![inline.to_vec()],
        Some(_) => return Err(INVALID),
        None => (0..count)
            .map(|index| {
                record
                    .bytes(&chunk_field(index))
                    .map(<[u8]>::to_vec)
                    .ok_or(INVALID)
            })
            .collect::<Result<_, _>>()?,
    };
    Ok(Decoded {
        version,
        kind,
        chunks,
    })
}
