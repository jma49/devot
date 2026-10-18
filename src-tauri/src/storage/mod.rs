//! SQLite storage. The core library owns note logic (Yjs, HLC, last-writer-
//! wins); this layer stores and returns whole records.

mod db;
mod readable;

pub use db::Db;

use rusqlite::backup::{Backup, StepResult};
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Numbered migrations, applied in order. Never edit a released one.
const MIGRATIONS: &[&str] = &[
    include_str!("../../migrations/0001_notes.sql"),
    include_str!("../../migrations/0002_books.sql"),
    include_str!("../../migrations/0003_tags_status_pin.sql"),
    include_str!("../../migrations/0004_purge.sql"),
    include_str!("../../migrations/0005_search.sql"),
    include_str!("../../migrations/0006_files.sql"),
    include_str!("../../migrations/0007_links.sql"),
    include_str!("../../migrations/0008_ai_access.sql"),
    include_str!("../../migrations/0009_revisions.sql"),
    include_str!("../../migrations/0010_book_order.sql"),
    include_str!("../../migrations/0011_tag_colours.sql"),
    include_str!("../../migrations/0012_activity.sql"),
    include_str!("../../migrations/0013_compaction.sql"),
    include_str!("../../migrations/0014_list_indexes.sql"),
    include_str!("../../migrations/0015_search_index_writes.sql"),
    include_str!("../../migrations/0016_body_versions.sql"),
    include_str!("../../migrations/0017_note_dates.sql"),
];

/// The schema version a fully migrated database reports.
pub const SCHEMA_VERSION: u32 = MIGRATIONS.len() as u32;

#[derive(Debug)]
pub enum StorageError {
    Sqlite(rusqlite::Error),
    NewerSchema(u32),
    SnapshotCheckFailed,
    /// A note write based on a body version the stored body has moved on
    /// from: another process wrote the note since its writer read it.
    BodyStale,
}

/// The code a SQLite failure is reported and logged with, by its kind:
/// busy, full, read-only, corrupt, an I/O failure or a file that cannot be
/// made or opened (a folder missing or that may not be written), and a
/// general one for anything else. Never SQLite's message, which can quote a
/// statement or the data it was given.
fn sqlite_code(error: &rusqlite::Error) -> &'static str {
    use rusqlite::ErrorCode;
    match error.sqlite_error_code() {
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => "E_STORAGE_BUSY",
        Some(ErrorCode::DiskFull) => "E_STORAGE_FULL",
        Some(ErrorCode::ReadOnly) => "E_STORAGE_READONLY",
        Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase) => "E_STORAGE_CORRUPT",
        Some(ErrorCode::SystemIoFailure) => "E_STORAGE_IO",
        Some(ErrorCode::CannotOpen) => "E_STORAGE_CANTOPEN",
        _ => "E_STORAGE_SQLITE",
    }
}

impl std::fmt::Display for StorageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sqlite(error) => f.write_str(sqlite_code(error)),
            Self::NewerSchema(found) => write!(f, "E_STORAGE_SCHEMA_TOO_NEW v{found}"),
            Self::SnapshotCheckFailed => f.write_str("E_STORAGE_SNAPSHOT_CHECK_FAILED"),
            Self::BodyStale => f.write_str("E_NOTE_BODY_STALE"),
        }
    }
}

impl std::error::Error for StorageError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Sqlite(error) => Some(error),
            Self::NewerSchema(_) | Self::SnapshotCheckFailed | Self::BodyStale => None,
        }
    }
}

impl From<rusqlite::Error> for StorageError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

pub type Result<T> = std::result::Result<T, StorageError>;

/// Copies every page from `from` to `to` in one step, waiting while the
/// source is busy. One step reads a consistent snapshot; in WAL mode writers
/// on other connections carry on meanwhile.
fn copy_pages(from: &Connection, to: &mut Connection) -> Result<()> {
    let backup = Backup::new(from, to)?;
    loop {
        match backup.step(-1)? {
            StepResult::Done => return Ok(()),
            StepResult::More => {}
            _ => std::thread::sleep(std::time::Duration::from_millis(50)),
        }
    }
}

fn open_read_only(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(conn)
}

/// Writes a copy of the database at `db_path` to `dest` with SQLite's online
/// backup API, from its own read-only connection so the app's writes are not
/// held up, then checks the copy.
pub fn snapshot(db_path: &Path, dest: &Path) -> Result<()> {
    let source = open_read_only(db_path)?;
    let mut copy = Connection::open(dest)?;
    copy_pages(&source, &mut copy)?;
    // The copy inherits WAL mode; a rollback journal keeps it one file, so
    // reading it later leaves no -wal or -shm beside it.
    copy.pragma_update(None, "journal_mode", "DELETE")?;
    let check: String = copy.pragma_query_value(None, "quick_check", |row| row.get(0))?;
    if check != "ok" {
        return Err(StorageError::SnapshotCheckFailed);
    }
    Ok(())
}

/// One note as stored. `ydoc` is the Yjs document state; `body_md` is the
/// Markdown snapshot the core derived from it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRecord {
    pub id: String,
    pub title: String,
    pub title_hlc: String,
    pub body_md: String,
    pub ydoc: Vec<u8>,
    /// The version of the stored body this record's body is based on: read,
    /// the stored one; written, the one its writer last saw (see
    /// `Store::put_note`). 0 for a note not written yet.
    pub body_version: i64,
    pub book_id: Option<String>,
    pub book_hlc: String,
    /// One of `NOTE_STATUSES`.
    pub status: String,
    pub status_hlc: String,
    pub pinned: bool,
    pub pinned_hlc: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// HLC of the last hand-set change to the dates; empty when never set.
    pub dates_hlc: String,
    pub deleted_at: Option<i64>,
    pub deleted_hlc: Option<String>,
}

/// The values `notes.status` accepts (the schema checks them too).
pub const NOTE_STATUSES: [&str; 5] = ["none", "active", "on_hold", "completed", "dropped"];

/// The tag colour palette: the IDs `tags.color` may hold. Each theme maps an
/// ID to a colour (design tokens `color.tag.<id>`). Same list as
/// `TAG_COLORS` in src/core/storage.ts.
pub const TAG_COLORS: [&str; 8] = [
    "red", "orange", "yellow", "green", "blue", "purple", "pink", "gray",
];

/// A tag. Notes carry tags through `NoteTagRecord` rows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagRecord {
    pub id: String,
    pub name: String,
    pub name_hlc: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    pub deleted_hlc: Option<String>,
    /// A palette ID from `TAG_COLORS`; None for no colour. Listing reads an
    /// ID it does not know (from a later palette) as None.
    #[serde(default)]
    pub color: Option<String>,
    /// Empty when the colour was never set.
    #[serde(default)]
    pub color_hlc: String,
}

/// An attachment's bytes and the metadata the protocol handler serves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileRecord {
    pub id: String,
    pub note_id: String,
    pub name: String,
    pub mime: String,
    pub data: Vec<u8>,
    pub created_at: i64,
}

/// An attachment to copy (`from`) and the ID its copy takes (`to`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileCopy {
    pub from: String,
    pub to: String,
}

/// A note in the trash, as the trash list shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashedNote {
    pub id: String,
    pub title: String,
    pub deleted_at: i64,
    pub book_id: Option<String>,
}

/// Whether a tag is on a note. Adding and removing write the same row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteTagRecord {
    pub note_id: String,
    pub tag_id: String,
    pub present: bool,
    pub hlc: String,
}

/// A notebook. Notebooks nest through `parent_id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookRecord {
    pub id: String,
    pub name: String,
    pub name_hlc: String,
    pub parent_id: Option<String>,
    pub parent_hlc: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    pub deleted_hlc: Option<String>,
    /// Allow AI Access: devot-mcp sees the notebook's own notes (not its
    /// sub-notebooks'). Off by default.
    #[serde(default)]
    pub ai_access: bool,
    /// Empty when the switch was never set.
    #[serde(default)]
    pub ai_access_hlc: String,
    /// Its place among its siblings, a fractional index (src/core/order.ts):
    /// siblings show in key order, equal keys in ID order.
    #[serde(default)]
    pub sort_key: String,
    /// Empty when the notebook was never moved among its siblings.
    #[serde(default)]
    pub sort_key_hlc: String,
}

/// The kinds of revision: a body version or a metadata event.
pub const REVISION_KINDS: [&str; 5] = ["body", "title", "book", "status", "pinned"];

/// The value of a baseline: the body version that keeps the text a note had
/// when its history began. The activity heatmap does not count it (see
/// `BASELINE` in src/core/revisions.ts).
pub const BASELINE: &str = "baseline";

/// One entry of a note's revision history, local to this device. A body
/// version holds the Yjs state and its text length (and `BASELINE` as its
/// value when it is a baseline, otherwise none); an event holds the new
/// value of the field (see migrations/0009_revisions.sql).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionRecord {
    pub id: String,
    pub note_id: String,
    /// One of `REVISION_KINDS`.
    pub kind: String,
    pub at: i64,
    pub ydoc: Option<Vec<u8>>,
    pub length: Option<i64>,
    pub value: Option<String>,
}

/// A revision without its Yjs state, as history lists show it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionSummary {
    pub id: String,
    pub note_id: String,
    pub kind: String,
    pub at: i64,
    pub length: Option<i64>,
    pub value: Option<String>,
}

/// A plain body version (never a baseline) a compaction sweep weighs,
/// without its state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactableVersion {
    pub note_id: String,
    pub id: String,
    pub at: i64,
}

/// Revision history and its compaction, the same statements as the
/// TypeScript adapter's (src/mcp/sqlite.ts, REVISION_SQL; a test compares
/// them). The reads go through covering indexes (migration 0013's
/// revisions_history, and revisions_by_time), never a version's Yjs state.
/// A note's revisions, newest first:
const REVISION_HISTORY_SQL: &str = "SELECT id, note_id, kind, at, length, value FROM revisions
     WHERE note_id = @noteId ORDER BY at DESC, id DESC";
/// The plain body versions (a baseline is kept, so left out) of the first
/// `@limit` notes, by ID after `@after`, with one taken at or after `@from`
/// and before `@to`, and more than one taken before `@to`; by note, newest
/// first. Only the window's versions are scanned, and each such note's:
const COMPACTABLE_SQL: &str =
    "SELECT note_id AS noteId, id, at FROM revisions INDEXED BY revisions_history
     WHERE kind = 'body' AND value IS NULL AND note_id IN (
       SELECT w.note_id FROM (
         SELECT DISTINCT note_id FROM revisions INDEXED BY revisions_by_time
          WHERE at >= @from AND at < @to AND kind = 'body' AND value IS NULL
            AND note_id > @after) w
        WHERE (SELECT COUNT(*) FROM revisions p INDEXED BY revisions_history
                WHERE p.note_id = w.note_id AND p.at < @to
                  AND p.kind = 'body' AND p.value IS NULL) > 1
        ORDER BY w.note_id LIMIT @limit)
     ORDER BY note_id, at DESC, id DESC";
/// Deletes one plain body version; never an event or a baseline:
const COMPACT_DROP_SQL: &str =
    "DELETE FROM revisions WHERE id = @id AND kind = 'body' AND value IS NULL";
/// Records when the last sweep ran:
const COMPACT_SWEPT_SQL: &str = "INSERT INTO compaction (id, swept_at) VALUES (1, @at)
     ON CONFLICT (id) DO UPDATE SET swept_at = excluded.swept_at";
/// When the last sweep ran:
const LAST_COMPACTION_SQL: &str = "SELECT swept_at AS sweptAt FROM compaction WHERE id = 1";

/// A note's creation, as the activity heatmap counts it (src/core/activity.ts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityNote {
    pub id: String,
    pub created_at: i64,
}

/// A body version or a title change, as the activity heatmap counts it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRevision {
    pub note_id: String,
    /// `body` or `title`.
    pub kind: String,
    pub at: i64,
    /// A body version's length; none for a title change.
    pub length: Option<i64>,
    /// The length of the note's body version before this one; none for its
    /// first, and for a title change.
    pub previous: Option<i64>,
}

/// What storage holds about writing from some time on (see `list_activity`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivityData {
    pub notes: Vec<ActivityNote>,
    pub revisions: Vec<ActivityRevision>,
}

/// The activity statements, the same as the TypeScript adapter's
/// (src/mcp/sqlite.ts, ACTIVITY_SQL; a test compares them). Each reads a
/// covering index of migration 0012, never a table row (rows hold Yjs
/// states): only what falls in the window, and for each body version the
/// one before it (versions are ordered by time, then length, then rowid).
const ACTIVITY_NOTES_SQL: &str =
    "SELECT id, created_at AS createdAt FROM notes INDEXED BY notes_created
     WHERE purged_at IS NULL AND created_at >= @since";
const ACTIVITY_REVISIONS_SQL: &str = "SELECT r.note_id AS noteId, r.kind, r.at, r.length,
            CASE WHEN r.kind = 'body' THEN
              (SELECT p.length FROM revisions p INDEXED BY revisions_activity
                WHERE p.note_id = r.note_id AND p.kind = 'body'
                  AND (p.at, p.length, p.rowid) < (r.at, r.length, r.rowid)
                ORDER BY p.at DESC, p.length DESC, p.rowid DESC LIMIT 1)
            END AS previous
     FROM revisions r INDEXED BY revisions_by_time
     WHERE r.at >= @since AND r.kind IN ('body', 'title')
       AND (r.kind = 'title' OR r.value IS NULL)";

/// Run when a note (`@id`) is purged, before its attachments are deleted:
/// gives each attachment of the note that another note, not purged, still
/// shows (its Markdown holds the address `devot://file/<id>`) to that note,
/// a live one before one in the Trash, then the smallest ID. A link can
/// reach another note without a copy (cut or dragged Markdown, Paste as
/// Plain Text, devot-mcp, a restored version, an old duplicate), and its
/// image must stay. The search index finds those notes (a phrase match, so
/// no note is read whole); it ignores case, so `instr` checks the address
/// as written. The same statement as the TypeScript adapter's
/// (src/mcp/sqlite.ts, HAND_OVER_FILES_SQL; a test compares them).
const HAND_OVER_FILES_SQL: &str = r#"UPDATE files SET note_id = COALESCE((
       SELECT n.id FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
        WHERE notes_fts MATCH 'body_md : "devot://file/' || replace(files.id, '"', '""') || '"'
          AND n.purged_at IS NULL AND n.id <> files.note_id
          AND instr(n.body_md, 'devot://file/' || files.id) > 0
        ORDER BY n.deleted_at IS NOT NULL, n.id LIMIT 1), note_id)
     WHERE note_id = @id"#;

/// The note list and the Trash, the same statements as the TypeScript
/// adapter's (src/mcp/sqlite.ts, LIST_SQL; a test compares them). Each reads
/// an index that covers it (migration 0014), never a note's row: a note's
/// small columns come after its Markdown and its Yjs state, so reading them
/// from the row walks every overflow page of both. Live notes, most recently
/// updated first:
const NOTES_LIST_SQL: &str = "SELECT id, title, created_at AS createdAt, updated_at AS updatedAt, book_id AS bookId, status, pinned,
            (SELECT group_concat(nt.tag_id) FROM note_tags nt
               JOIN tags t ON t.id = nt.tag_id AND t.deleted_at IS NULL
              WHERE nt.note_id = notes.id AND nt.present = 1) AS tagIds
     FROM notes INDEXED BY notes_list
     WHERE deleted_at IS NULL ORDER BY updated_at DESC, id DESC";
/// Notes in the Trash (not purged), most recently deleted first:
const TRASH_LIST_SQL: &str =
    "SELECT id, title, deleted_at AS deletedAt, book_id AS bookId FROM notes INDEXED BY notes_trash
     WHERE deleted_at IS NOT NULL AND purged_at IS NULL ORDER BY deleted_at DESC, id DESC";

/// What the note list shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub book_id: Option<String>,
    pub status: String,
    pub pinned: bool,
    /// Live tags on the note.
    pub tag_ids: Vec<String>,
    /// Search results only: the body around the first searched word found
    /// there, starting with an ellipsis when it starts mid-body.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<String>,
}

/// A search, as the core sends it (src/core/storage.ts, NoteQuery): live
/// notes meeting every condition.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NoteQuery {
    pub text: Vec<TextCondition>,
    pub sets: Vec<SetCondition>,
    /// Only pinned notes (`Some(true)`), only notes not pinned (`Some(false)`), or either (`None`).
    pub pinned: Option<bool>,
}

/// Text the note must (or, with `negate`, must not) contain, case-insensitively.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextCondition {
    pub field: TextField,
    pub value: String,
    pub negate: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextField {
    /// The title or the body.
    Any,
    Title,
    Body,
}

/// The note's notebook, tag or status is one of `ids` (with `negate`: none).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetCondition {
    pub kind: SetKind,
    pub ids: Vec<String>,
    pub negate: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SetKind {
    Book,
    Tag,
    Status,
}

impl TextField {
    /// The text this field searches. With ranked text, a body is read from
    /// the note's row only once the note has come out of the ranked matches
    /// (`ranked`, by rank), so only the bodies of the matches up to a page
    /// of results are read; otherwise from the row the list's index points
    /// to.
    fn column(self, ranked: bool) -> String {
        let body = if ranked {
            "(SELECT body_md FROM notes b WHERE b.rowid = n.rid)"
        } else {
            "n.body_md"
        };
        match self {
            Self::Any => format!("n.title || char(10) || {body}"),
            Self::Title => "n.title".into(),
            Self::Body => body.into(),
        }
    }

    /// An FTS5 query for `value` as a literal string in this field's column.
    fn fts(self, value: &str) -> String {
        let column = match self {
            Self::Any => "",
            Self::Title => "title : ",
            Self::Body => "body_md : ",
        };
        format!("{column}\"{}\"", value.replace('"', "\"\""))
    }
}

/// Characters of body an excerpt shows, and how many of them come before
/// the word found (EXCERPT_* in src/core/search.ts).
const EXCERPT_CHARS: usize = 160;
const EXCERPT_BEFORE: usize = 40;

/// Characters of a long body read on each side of the place a word is found
/// there (EXCERPT_STRETCH in src/core/search.ts); a body of at most twice as
/// many is read whole.
const EXCERPT_STRETCH: usize = 300;
/// How many places of a word a long body's excerpt tries.
const EXCERPT_PLACES: usize = 8;

/// Lower case, one character for one (as the trigram index folds case), so
/// positions in the folded text are positions in the original.
fn fold(c: char) -> char {
    if c.is_ascii() {
        return c.to_ascii_lowercase();
    }
    let mut lower = c.to_lowercase();
    match (lower.next(), lower.next()) {
        (Some(l), None) => l,
        _ => c,
    }
}

/// `text` folded one character at a time (see `fold`). The SQL function
/// `devot_fold` is this: terms too short for the trigram index are scanned
/// with it, so they ignore case in every script, as the index does (SQLite's
/// own `lower()` folds ASCII only). devot-mcp registers the same function
/// (src/mcp/sqlite.ts) from the same cases (tests/support/folds.json).
fn fold_text(text: &str) -> String {
    if text.is_ascii() {
        text.to_ascii_lowercase()
    } else {
        text.chars().map(fold).collect()
    }
}

/// Registers `devot_fold(text)` on a connection: the folded text, or the
/// value itself when it is not text (NULL stays NULL).
fn register_fold(conn: &Connection) -> rusqlite::Result<()> {
    use rusqlite::functions::FunctionFlags;
    use rusqlite::types::{Value, ValueRef};
    conn.create_scalar_function(
        "devot_fold",
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            Ok(match ctx.get_raw(0) {
                ValueRef::Text(bytes) => Value::Text(fold_text(&String::from_utf8_lossy(bytes))),
                ValueRef::Null => Value::Null,
                ValueRef::Integer(i) => Value::Integer(i),
                ValueRef::Real(f) => Value::Real(f),
                ValueRef::Blob(b) => Value::Blob(b.to_vec()),
            })
        },
    )
}

/// Byte offset of the character `count` characters before `at` (or 0).
fn chars_back(text: &str, at: usize, count: usize) -> usize {
    text[..at]
        .char_indices()
        .rev()
        .take(count)
        .last()
        .map_or(at, |(i, _)| i)
}

/// Byte offset of the character `count` characters after `at` (or the end).
fn chars_ahead(text: &str, at: usize, count: usize) -> usize {
    text[at..]
        .char_indices()
        .nth(count)
        .map_or(text.len(), |(i, _)| at + i)
}

/// Where a body's text starts after a leading front matter block, as
/// `readable_text` reads one (a fence line, then another later); 0 without.
fn after_front_matter(body: &str) -> usize {
    let line_at = |from: usize| {
        let (line, next) = match body[from..].find('\n') {
            Some(i) => (&body[from..from + i], Some(from + i + 1)),
            None => (&body[from..], None),
        };
        (line.strip_suffix('\r').unwrap_or(line), next)
    };
    let (first, mut next) = line_at(0);
    if !readable::is_fence(first) {
        return 0;
    }
    while let Some(at) = next {
        let (line, after) = line_at(at);
        if readable::is_fence(line) {
            return after.unwrap_or(body.len());
        }
        next = after;
    }
    0
}

/// The first place at or after byte `from` where `body` holds `wanted` (folded
/// characters), folding as it goes: its start and end.
fn find_folded(body: &str, wanted: &[char], from: usize) -> Option<(usize, usize)> {
    let (&first, rest) = wanted.split_first()?;
    body[from..].char_indices().find_map(|(i, c)| {
        if fold(c) != first {
            return None;
        }
        let start = from + i;
        let mut end = start + c.len_utf8();
        let mut after = body[end..].chars();
        for &w in rest {
            let c = after.next().filter(|&c| fold(c) == w)?;
            end += c.len_utf8();
        }
        Some((start, end))
    })
}

/// Where the first of `terms` (in any case) shows in `text`.
struct Place {
    /// The text's characters.
    chars: Vec<char>,
    /// How many of them come before the term.
    before: usize,
    /// The excerpt's first one.
    from: usize,
}

/// Where the first of `terms` (in any case) shows in `text`, if one does.
fn place_in(text: &str, terms: &[&str]) -> Option<Place> {
    let chars: Vec<char> = text.chars().collect();
    let folded: String = chars.iter().map(|&c| fold(c)).collect();
    let before = terms.iter().find_map(|term| {
        let term: String = term.chars().map(fold).collect();
        if term.is_empty() {
            return None;
        }
        Some(folded[..folded.find(&term)?].chars().count())
    })?;
    Some(Place {
        chars,
        before,
        from: before.saturating_sub(EXCERPT_BEFORE),
    })
}

/// The spaces and line breaks that set words apart.
fn is_break(c: char) -> bool {
    matches!(c, ' ' | '\n' | '\t' | '\r')
}

/// Where an excerpt starting at character `from` begins to read: at `from`
/// when it falls at a word's start, else at the next word's, so an excerpt
/// never opens with the tail of a word. A cut that finds no break before the
/// term (a term in a long word, or text without spaces) stays where it
/// falls. Same rule as `wordStart` in src/core/search.ts.
fn word_start(place: &Place) -> usize {
    let (chars, from, at) = (&place.chars, place.from, place.before);
    if from == 0 || is_break(chars[from - 1]) || is_break(chars[from]) {
        return from;
    }
    let mut i = from;
    while i < at && !is_break(chars[i]) {
        i += 1;
    }
    if i >= at {
        return from;
    }
    while i < at && is_break(chars[i]) {
        i += 1;
    }
    i
}

/// The excerpt of a place; `cut` when its text starts after the body's start.
fn excerpt_at(place: &Place, cut: bool) -> String {
    let start = word_start(place);
    let mut excerpt = String::new();
    if cut || start > 0 {
        excerpt.push('\u{2026}');
    }
    excerpt.extend(place.chars[start..].iter().take(EXCERPT_CHARS));
    excerpt
}

/// About 160 characters of the readable text of `body` (no front matter, no
/// Markdown markers: see `readable`) from shortly before the first of
/// `terms` found in it (in any case), starting with an ellipsis when it
/// starts mid-text; None when no term is found there.
///
/// A body longer than twice `EXCERPT_STRETCH` characters is not read whole,
/// so a page of results costs the same however long the notes are: a term
/// is looked for as written (in any case), at most `EXCERPT_PLACES` times,
/// after any front matter, and each place is read with `EXCERPT_STRETCH`
/// characters on each side as a body of its own, growing a stretch at a
/// time while the word shows too near one of its ends for a whole excerpt.
/// Same rule, step for step, as `bodyExcerpt` in src/core/search.ts
/// (tests/support/excerpts.json holds cases both sides agree on).
pub(crate) fn body_excerpt(body: &str, terms: &[&str]) -> Option<String> {
    if body.chars().nth(2 * EXCERPT_STRETCH).is_none() {
        return place_in(&readable::readable_text(body), terms).map(|p| excerpt_at(&p, false));
    }
    let text = after_front_matter(body);
    // The readable text of body[start..stop], read as a body of its own: a
    // blank first line, so front matter is read only at the body's start.
    let readable = |start: usize, stop: usize| {
        if start == 0 {
            readable::readable_text(&body[..stop])
        } else {
            readable::readable_text(&format!("\n{}", &body[start..stop]))
        }
    };
    for term in terms {
        let wanted: Vec<char> = term.chars().map(fold).collect();
        let mut from = text;
        for _ in 0..EXCERPT_PLACES {
            let Some((at, end)) = find_folded(body, &wanted, from) else {
                break;
            };
            // EXCERPT_STRETCH characters on each side, from the body's start
            // when that reaches the front matter.
            let mut start = chars_back(body, at, EXCERPT_STRETCH);
            if start <= text {
                start = 0;
            }
            let mut stop = chars_ahead(body, end, EXCERPT_STRETCH);
            let mut place = place_in(&readable(start, stop), &[term]);
            // Shown near an end of the stretch (another place than this
            // one): read further that way, a stretch at a time, until the
            // excerpt fits.
            for _ in 0..EXCERPT_PLACES {
                let Some(found) = &place else { break };
                let short = start > 0 && found.before < EXCERPT_BEFORE;
                let long = stop < body.len() && found.chars.len() - found.from < EXCERPT_CHARS;
                if !short && !long {
                    break;
                }
                if short {
                    start = chars_back(body, start, EXCERPT_STRETCH);
                }
                if start <= text {
                    start = 0;
                }
                if long {
                    stop = chars_ahead(body, stop, EXCERPT_STRETCH);
                }
                place = place_in(&readable(start, stop), &[term]);
            }
            if let Some(found) = place {
                return Some(excerpt_at(&found, start > 0));
            }
            from = at + body[at..].chars().next().map_or(1, char::len_utf8);
        }
    }
    None
}

/// Text long enough for the trigram index.
fn indexable(value: &str) -> bool {
    value.chars().count() >= 3
}

/// How a scan for a term too short for the trigram index finds what
/// `devot_fold` would, more cheaply than folding every text it reads (#48;
/// `scanFolding` in src/core/search.ts, the same).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScanFolding {
    /// No character folds to any of the term's but itself: the text is read
    /// as written.
    None,
    /// Those and ASCII letters, which only an ASCII capital and the Kelvin
    /// sign (U+212A, to k) fold to: the text is read through SQLite's
    /// lower() (ASCII only) with the Kelvin sign replaced by `k`.
    Ascii,
    /// Anything else: the text is read through `devot_fold`.
    Fold,
}

/// Whether no character but `c` itself folds to `c` (see `fold`): ASCII
/// other than letters, CJK symbols and punctuation, kana, the CJK
/// ideographs and Hangul. A test checks every character.
fn caseless(c: char) -> bool {
    matches!(c,
        '\0'..='\x40' | '\x5b'..='\x60' | '\x7b'..='\x7f'
        | '\u{3000}'..='\u{9fff}' | '\u{ac00}'..='\u{d7a3}' | '\u{f900}'..='\u{faff}'
        | '\u{20000}'..='\u{3ffff}')
}

fn scan_folding(text: &str) -> ScanFolding {
    if text.chars().all(caseless) {
        ScanFolding::None
    } else if text.chars().all(|c| c.is_ascii() || caseless(c)) {
        ScanFolding::Ascii
    } else {
        ScanFolding::Fold
    }
}

/// The clause for text too short for the trigram index (its parameter
/// `value`): it scans the field's text, folded as the index folds case
/// (see `ScanFolding`), the title and the body apart when the text has no
/// line break (only such text could run from the title into the body).
/// The TypeScript adapter's `scanClause` builds the same.
fn scan_clause(t: &TextCondition, ranked: bool, value: &str) -> String {
    let columns = if t.field == TextField::Any && !t.value.contains('\n') {
        vec![
            TextField::Title.column(ranked),
            TextField::Body.column(ranked),
        ]
    } else {
        vec![t.field.column(ranked)]
    };
    let folding = scan_folding(&t.value);
    // The Kelvin sign matters only to a term with a k.
    let kelvin = t.value.contains(['k', 'K']);
    let found: Vec<String> = columns
        .iter()
        .map(|c| match folding {
            ScanFolding::None => format!("instr({c}, {value}) > 0"),
            ScanFolding::Ascii if kelvin => {
                format!("instr(lower(replace({c}, char(8490), 'k')), lower({value})) > 0")
            }
            ScanFolding::Ascii => format!("instr(lower({c}), lower({value})) > 0"),
            ScanFolding::Fold => format!("instr(devot_fold({c}), devot_fold({value})) > 0"),
        })
        .collect();
    let any = if found.len() > 1 {
        format!("({})", found.join(" OR "))
    } else {
        found.join("")
    };
    if t.negate { format!("NOT {any}") } else { any }
}

/// A note list or search row (see `NOTES_LIST_SQL` and `search_sql`).
fn summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<NoteSummary> {
    let tags: Option<String> = row.get(7)?;
    Ok(NoteSummary {
        id: row.get(0)?,
        title: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
        book_id: row.get(4)?,
        status: row.get(5)?,
        pinned: row.get(6)?,
        tag_ids: tags
            .map(|t| t.split(',').map(String::from).collect())
            .unwrap_or_default(),
        excerpt: None,
    })
}

/// A search as SQL and its parameters, the same as the TypeScript adapter
/// builds (src/mcp/sqlite.ts, searchStatement): every condition is one
/// clause of a WHERE, so the limit applies after all of them. Live notes
/// come from the list's index (notes_list), never from their rows: ranked
/// text (three or more characters) matches the trigram index first (`hits`,
/// with each match's rank), and the list's index joins them through an
/// index SQLite builds for the query. So a ranked search walks the whole
/// list index even for one match (O(notes), about 2.5 ms for 50,000 notes):
/// letting the matches drive the join would read each match's row through
/// its blobs, which costs twice as much once a word is in many notes (see
/// tests/core/list-cost.test.ts). Shorter text is scanned: it reads
/// bodies. With ranked text, the matches meeting every other condition are
/// put in rank order first (`ranked`), and the scan reads them in that
/// order, which also gives the results' order: so it stops once a page of
/// results is full, instead of reading the body of every match (#48). Ties
/// go to the newer note, then by ID, as the note list orders them.
fn search_sql(query: &NoteQuery, limit: u32) -> (String, Vec<String>) {
    let mut values: Vec<String> = Vec::new();
    // Numbered parameters: the SQL is built out of order.
    let mut param = |value: String| {
        values.push(value);
        format!("?{}", values.len())
    };
    let ranked: Vec<&TextCondition> = query
        .text
        .iter()
        .filter(|t| !t.negate && indexable(&t.value))
        .collect();
    let mut clauses = vec![
        "n.deleted_at IS NULL".to_string(),
        "n.purged_at IS NULL".to_string(),
    ];
    let mut scans: Vec<String> = Vec::new();
    for t in &query.text {
        if !indexable(&t.value) {
            let value = param(t.value.clone());
            scans.push(scan_clause(t, !ranked.is_empty(), &value));
        } else if t.negate {
            clauses.push(format!(
                "n.rowid NOT IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH {})",
                param(t.field.fts(&t.value))
            ));
        }
    }
    for set in &query.sets {
        let json = serde_json::to_string(&set.ids).unwrap_or_default();
        let ids = format!("(SELECT value FROM json_each({}))", param(json));
        clauses.push(match (set.kind, set.negate) {
            (SetKind::Book, false) => format!("n.book_id IN {ids}"),
            (SetKind::Book, true) => format!("(n.book_id IS NULL OR n.book_id NOT IN {ids})"),
            (SetKind::Status, false) => format!("n.status IN {ids}"),
            (SetKind::Status, true) => format!("n.status NOT IN {ids}"),
            (SetKind::Tag, negate) => format!(
                "{}EXISTS (SELECT 1 FROM note_tags nt
                   WHERE nt.note_id = n.id AND nt.present = 1 AND nt.tag_id IN {ids})",
                if negate { "NOT " } else { "" }
            ),
        });
    }
    match query.pinned {
        Some(true) => clauses.push("n.pinned = 1".into()),
        Some(false) => clauses.push("n.pinned = 0".into()),
        None => {}
    }
    let hits = if ranked.is_empty() {
        String::new()
    } else {
        let all: Vec<String> = ranked.iter().map(|t| t.field.fts(&t.value)).collect();
        format!(
            "WITH hits AS MATERIALIZED (SELECT rowid AS rid, bm25(notes_fts) AS score
               FROM notes_fts WHERE notes_fts MATCH {})",
            param(all.join(" AND "))
        )
    };
    let select = "SELECT n.id, n.title, n.created_at AS createdAt, n.updated_at AS updatedAt, n.book_id AS bookId, n.status, n.pinned,
                (SELECT group_concat(nt.tag_id) FROM note_tags nt
                   JOIN tags t ON t.id = nt.tag_id AND t.deleted_at IS NULL
                  WHERE nt.note_id = n.id AND nt.present = 1) AS tagIds";
    // Ranked text and a scan: the matches meeting every other condition, in
    // rank order. The scan reads them in that order and stops at a page only
    // because SQLite keeps a MATERIALIZED CTE's order and uses it for the
    // same ORDER BY outside (the results stay right if it did not, only
    // slower; tests check the plan and how many bodies are read).
    let early = !hits.is_empty() && !scans.is_empty();
    let (source, conditions, score) = if early {
        (
            format!(
                "{hits},
                 ranked AS MATERIALIZED (SELECT n.rowid AS rid, h.score, n.id, n.title, n.created_at,
                     n.updated_at, n.book_id, n.status, n.pinned
                   FROM notes n INDEXED BY notes_list JOIN hits h ON h.rid = n.rowid
                   WHERE {}
                   ORDER BY h.score, n.updated_at DESC, n.id DESC)
                 {select} FROM ranked n",
                clauses.join(" AND ")
            ),
            scans,
            "n.score, ",
        )
    } else if hits.is_empty() {
        clauses.extend(scans);
        (
            format!("{select} FROM notes n INDEXED BY notes_list"),
            clauses,
            "",
        )
    } else {
        clauses.extend(scans);
        (
            format!(
                "{hits} {select} FROM notes n INDEXED BY notes_list JOIN hits h ON h.rid = n.rowid"
            ),
            clauses,
            "h.score, ",
        )
    };
    let sql = format!(
        "{source}
         WHERE {}
         ORDER BY {score}n.updated_at DESC, n.id DESC LIMIT {limit}",
        conditions.join(" AND ")
    );
    (sql, values)
}

pub struct Store {
    conn: Connection,
}

impl Store {
    /// Opens (creating if needed) the database and applies pending migrations.
    pub fn open(path: &Path) -> Result<Self> {
        let mut conn = Connection::open(path)?;
        register_fold(&conn)?;
        // WAL lets devot-mcp read while Devot writes; FULL sync because data
        // integrity outranks write speed.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        // Every transaction takes the write lock when it begins, so it waits
        // out another writer (devot-mcp) for the busy timeout. A deferred one
        // that has read (an attachment's note, the search index on its first
        // use) would fail at once when it then needs to write.
        conn.set_transaction_behavior(TransactionBehavior::Immediate);
        let mut store = Self { conn };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&mut self) -> Result<()> {
        let current: u32 = self
            .conn
            .pragma_query_value(None, "user_version", |row| row.get(0))?;
        if current > SCHEMA_VERSION {
            return Err(StorageError::NewerSchema(current));
        }
        for (index, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
            let tx = self.conn.transaction()?;
            tx.execute_batch(sql)?;
            tx.pragma_update(None, "user_version", index as u32 + 1)?;
            tx.commit()?;
        }
        Ok(())
    }

    /// Replaces the whole database with the snapshot at `path`, then brings it
    /// up to the current schema. A snapshot from a newer Devot is refused.
    pub fn restore_from(&mut self, path: &Path) -> Result<()> {
        let source = open_read_only(path)?;
        let version: u32 = source.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version > SCHEMA_VERSION {
            return Err(StorageError::NewerSchema(version));
        }
        copy_pages(&source, &mut self.conn)?;
        self.conn.pragma_update(None, "journal_mode", "WAL")?;
        self.migrate()
    }

    /// Changes whenever another connection (devot-mcp, say) commits to the
    /// database; this connection's own commits leave it alone.
    pub fn data_version(&self) -> Result<u32> {
        Ok(self
            .conn
            .pragma_query_value(None, "data_version", |row| row.get(0))?)
    }

    #[cfg(test)]
    pub fn schema_version(&self) -> Result<u32> {
        Ok(self
            .conn
            .pragma_query_value(None, "user_version", |row| row.get(0))?)
    }

    #[cfg(test)]
    pub fn integrity_ok(&self) -> Result<bool> {
        let result: String = self
            .conn
            .pragma_query_value(None, "integrity_check", |row| row.get(0))?;
        Ok(result == "ok")
    }

    /// Notes not in the trash, most recently updated first.
    pub fn list_notes(&self) -> Result<Vec<NoteSummary>> {
        let mut statement = self.conn.prepare_cached(NOTES_LIST_SQL)?;
        let rows = statement.query_map([], summary)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// A note that is not in the trash; with `trashed`, a trashed one too
    /// (never a purged one).
    pub fn get_note(&self, id: &str, trashed: bool) -> Result<Option<NoteRecord>> {
        let mut statement = self.conn.prepare_cached(
            "SELECT id, title, title_hlc, body_md, ydoc, created_at, updated_at,
                    deleted_at, deleted_hlc, book_id, book_hlc, status, status_hlc,
                    pinned, pinned_hlc, body_version, dates_hlc
             FROM notes WHERE id = ?1 AND purged_at IS NULL AND (?2 OR deleted_at IS NULL)",
        )?;
        Ok(statement
            .query_row(params![id, trashed], |row| {
                Ok(NoteRecord {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    title_hlc: row.get(2)?,
                    body_md: row.get(3)?,
                    ydoc: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                    deleted_at: row.get(7)?,
                    deleted_hlc: row.get(8)?,
                    book_id: row.get(9)?,
                    book_hlc: row.get(10)?,
                    status: row.get(11)?,
                    status_hlc: row.get(12)?,
                    pinned: row.get(13)?,
                    pinned_hlc: row.get(14)?,
                    body_version: row.get(15)?,
                    dates_hlc: row.get(16)?,
                })
            })
            .optional()?)
    }

    /// Inserts a note, or merges it field by field: each metadata field keeps
    /// the value with the newer HLC, so a stale copy never undoes a newer
    /// change. The body (Yjs state and its snapshot) is written as given.
    /// The TypeScript adapter (tests/support/sqlite-adapter.ts) does the same.
    /// Writes a note and replaces its link index rows with `links` (the
    /// note IDs its body links to), unless the note was purged.
    ///
    /// A compare-and-set on the body: the note is written only while its
    /// stored body is still at `note.body_version`, the version its writer
    /// last saw, and its body moves on to the next one (a new note is stored
    /// at the next one too). A write based on another version, which would
    /// go over a body another process wrote since, is refused with
    /// `StorageError::BodyStale` and changes nothing; its writer takes the
    /// stored body in and writes again. A purged note is left alone,
    /// whatever the version.
    pub fn put_note(&mut self, note: &NoteRecord, links: &[String]) -> Result<()> {
        let tx = self.conn.transaction()?;
        let written = tx.execute(
            "INSERT INTO notes (id, title, title_hlc, body_md, ydoc, book_id, book_hlc,
                                status, status_hlc, pinned, pinned_hlc,
                                created_at, updated_at, deleted_at, deleted_hlc, body_version,
                                dates_hlc)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16 + 1, ?17)
             ON CONFLICT (id) DO UPDATE SET
               title = CASE WHEN excluded.title_hlc > title_hlc THEN excluded.title ELSE title END,
               title_hlc = MAX(excluded.title_hlc, title_hlc),
               book_id = CASE WHEN excluded.book_hlc > book_hlc THEN excluded.book_id ELSE book_id END,
               book_hlc = MAX(excluded.book_hlc, book_hlc),
               status = CASE WHEN excluded.status_hlc > status_hlc THEN excluded.status ELSE status END,
               status_hlc = MAX(excluded.status_hlc, status_hlc),
               pinned = CASE WHEN excluded.pinned_hlc > pinned_hlc THEN excluded.pinned ELSE pinned END,
               pinned_hlc = MAX(excluded.pinned_hlc, pinned_hlc),
               deleted_at = CASE WHEN COALESCE(excluded.deleted_hlc, '') > COALESCE(deleted_hlc, '')
                                 THEN excluded.deleted_at ELSE deleted_at END,
               deleted_hlc = CASE WHEN COALESCE(excluded.deleted_hlc, '') > COALESCE(deleted_hlc, '')
                                  THEN excluded.deleted_hlc ELSE deleted_hlc END,
               body_md = excluded.body_md, ydoc = excluded.ydoc,
               body_version = excluded.body_version,
               created_at = CASE WHEN excluded.dates_hlc > dates_hlc
                                 THEN excluded.created_at ELSE created_at END,
               updated_at = CASE WHEN excluded.dates_hlc > dates_hlc
                                 THEN excluded.updated_at ELSE MAX(excluded.updated_at, updated_at) END,
               dates_hlc = MAX(excluded.dates_hlc, dates_hlc)
             WHERE purged_at IS NULL AND body_version = ?16",
            params![
                note.id,
                note.title,
                note.title_hlc,
                note.body_md,
                note.ydoc,
                note.book_id,
                note.book_hlc,
                note.status,
                note.status_hlc,
                note.pinned,
                note.pinned_hlc,
                note.created_at,
                note.updated_at,
                note.deleted_at,
                note.deleted_hlc,
                note.body_version,
                note.dates_hlc
            ],
        )?;
        if written == 0 {
            // Nothing written: the note was purged (left alone), or its body
            // moved on from the version the write is based on.
            let purged: bool = tx.query_row(
                "SELECT purged_at IS NOT NULL FROM notes WHERE id = ?1",
                [&note.id],
                |row| row.get(0),
            )?;
            if !purged {
                return Err(StorageError::BodyStale);
            }
        }
        if written > 0 {
            tx.execute("DELETE FROM links WHERE source_id = ?1", [&note.id])?;
            let mut insert =
                tx.prepare("INSERT OR IGNORE INTO links (source_id, target_id) VALUES (?1, ?2)")?;
            for target in links {
                insert.execute(params![note.id, target])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Notebooks that are not deleted.
    pub fn list_books(&self) -> Result<Vec<BookRecord>> {
        let mut statement = self.conn.prepare_cached(
            "SELECT id, name, name_hlc, parent_id, parent_hlc, created_at, updated_at,
                    deleted_at, deleted_hlc, ai_access, ai_access_hlc, sort_key, sort_key_hlc
             FROM books WHERE deleted_at IS NULL ORDER BY id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(BookRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                name_hlc: row.get(2)?,
                parent_id: row.get(3)?,
                parent_hlc: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                deleted_at: row.get(7)?,
                deleted_hlc: row.get(8)?,
                ai_access: row.get(9)?,
                ai_access_hlc: row.get(10)?,
                sort_key: row.get(11)?,
                sort_key_hlc: row.get(12)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Inserts a notebook, or merges it field by field (newer HLC wins).
    pub fn put_book(&mut self, book: &BookRecord) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO books (id, name, name_hlc, parent_id, parent_hlc, created_at,
                                updated_at, deleted_at, deleted_hlc, ai_access, ai_access_hlc,
                                sort_key, sort_key_hlc)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT (id) DO UPDATE SET
               name = CASE WHEN excluded.name_hlc > name_hlc THEN excluded.name ELSE name END,
               name_hlc = MAX(excluded.name_hlc, name_hlc),
               parent_id = CASE WHEN excluded.parent_hlc > parent_hlc
                                THEN excluded.parent_id ELSE parent_id END,
               parent_hlc = MAX(excluded.parent_hlc, parent_hlc),
               ai_access = CASE WHEN excluded.ai_access_hlc > ai_access_hlc
                                THEN excluded.ai_access ELSE ai_access END,
               ai_access_hlc = MAX(excluded.ai_access_hlc, ai_access_hlc),
               -- Equal clocks (keys the core gave old notebooks on two devices):
               -- the greater key wins, so both sides end with the same one.
               sort_key = CASE WHEN excluded.sort_key_hlc > sort_key_hlc
                                 OR (excluded.sort_key_hlc = sort_key_hlc
                                     AND excluded.sort_key > sort_key)
                               THEN excluded.sort_key ELSE sort_key END,
               sort_key_hlc = MAX(excluded.sort_key_hlc, sort_key_hlc),
               deleted_at = CASE WHEN COALESCE(excluded.deleted_hlc, '') > COALESCE(deleted_hlc, '')
                                 THEN excluded.deleted_at ELSE deleted_at END,
               deleted_hlc = CASE WHEN COALESCE(excluded.deleted_hlc, '') > COALESCE(deleted_hlc, '')
                                  THEN excluded.deleted_hlc ELSE deleted_hlc END,
               updated_at = MAX(excluded.updated_at, updated_at)",
            params![
                book.id,
                book.name,
                book.name_hlc,
                book.parent_id,
                book.parent_hlc,
                book.created_at,
                book.updated_at,
                book.deleted_at,
                book.deleted_hlc,
                book.ai_access,
                book.ai_access_hlc,
                book.sort_key,
                book.sort_key_hlc
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Tags that are not deleted.
    pub fn list_tags(&self) -> Result<Vec<TagRecord>> {
        let mut statement = self.conn.prepare_cached(
            "SELECT id, name, name_hlc, created_at, updated_at, deleted_at, deleted_hlc,
                    color, color_hlc
             FROM tags WHERE deleted_at IS NULL ORDER BY id",
        )?;
        let rows = statement.query_map([], |row| {
            let color: Option<String> = row.get(7)?;
            Ok(TagRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                name_hlc: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                deleted_at: row.get(5)?,
                deleted_hlc: row.get(6)?,
                color: color.filter(|c| TAG_COLORS.contains(&c.as_str())),
                color_hlc: row.get(8)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Inserts a tag, or merges it field by field (newer HLC wins).
    pub fn put_tag(&mut self, tag: &TagRecord) -> Result<()> {
        self.conn.execute(
            "INSERT INTO tags (id, name, name_hlc, created_at, updated_at, deleted_at, deleted_hlc,
                               color, color_hlc)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT (id) DO UPDATE SET
               name = CASE WHEN excluded.name_hlc > name_hlc THEN excluded.name ELSE name END,
               name_hlc = MAX(excluded.name_hlc, name_hlc),
               color = CASE WHEN excluded.color_hlc > color_hlc THEN excluded.color ELSE color END,
               color_hlc = MAX(excluded.color_hlc, color_hlc),
               deleted_at = CASE WHEN COALESCE(excluded.deleted_hlc, '') > COALESCE(deleted_hlc, '')
                                 THEN excluded.deleted_at ELSE deleted_at END,
               deleted_hlc = CASE WHEN COALESCE(excluded.deleted_hlc, '') > COALESCE(deleted_hlc, '')
                                  THEN excluded.deleted_hlc ELSE deleted_hlc END,
               updated_at = MAX(excluded.updated_at, updated_at)",
            params![
                tag.id,
                tag.name,
                tag.name_hlc,
                tag.created_at,
                tag.updated_at,
                tag.deleted_at,
                tag.deleted_hlc,
                tag.color,
                tag.color_hlc
            ],
        )?;
        Ok(())
    }

    /// Writes a note's tag membership; the newer HLC wins.
    pub fn put_note_tag(&mut self, link: &NoteTagRecord) -> Result<()> {
        self.conn.execute(
            "INSERT INTO note_tags (note_id, tag_id, present, hlc) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (note_id, tag_id) DO UPDATE SET
               present = CASE WHEN excluded.hlc > hlc THEN excluded.present ELSE present END,
               hlc = MAX(excluded.hlc, hlc)",
            params![link.note_id, link.tag_id, link.present, link.hlc],
        )?;
        Ok(())
    }

    /// A note's membership row for a tag, on or off, with its HLC; none when
    /// it was never written. The core reads it before writing the row, so
    /// its clock ticks past the stored one. The TypeScript adapter
    /// (src/mcp/sqlite.ts) runs the same statement.
    pub fn get_note_tag(&self, note_id: &str, tag_id: &str) -> Result<Option<NoteTagRecord>> {
        let mut statement = self.conn.prepare_cached(
            "SELECT note_id, tag_id, present, hlc FROM note_tags WHERE note_id = ? AND tag_id = ?",
        )?;
        Ok(statement
            .query_row(params![note_id, tag_id], |row| {
                Ok(NoteTagRecord {
                    note_id: row.get(0)?,
                    tag_id: row.get(1)?,
                    present: row.get(2)?,
                    hlc: row.get(3)?,
                })
            })
            .optional()?)
    }

    /// Notes in the trash (not purged), most recently deleted first.
    pub fn list_trash(&self) -> Result<Vec<TrashedNote>> {
        let mut statement = self.conn.prepare_cached(TRASH_LIST_SQL)?;
        let rows = statement.query_map([], |row| {
            Ok(TrashedNote {
                id: row.get(0)?,
                title: row.get(1)?,
                deleted_at: row.get(2)?,
                book_id: row.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Deletes a note permanently: wipes its content and tags, keeps its ID
    /// and clocks as a tombstone, and marks it purged. Final: `put_note`
    /// never changes a purged row. Its attachments go too, except those
    /// another note that is not purged still shows: they pass to that note
    /// (`HAND_OVER_FILES_SQL`).
    pub fn purge_note(&mut self, id: &str, at: i64, hlc: &str) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "UPDATE notes SET title = '', title_hlc = MAX(title_hlc, ?3), body_md = '', ydoc = x'',
               deleted_at = COALESCE(deleted_at, ?2),
               deleted_hlc = MAX(COALESCE(deleted_hlc, ''), ?3), purged_at = ?2
             WHERE id = ?1 AND purged_at IS NULL",
            params![id, at, hlc],
        )?;
        tx.execute("DELETE FROM note_tags WHERE note_id = ?1", [id])?;
        tx.execute(HAND_OVER_FILES_SQL, rusqlite::named_params! { "@id": id })?;
        tx.execute("DELETE FROM files WHERE note_id = ?1", [id])?;
        tx.execute("DELETE FROM links WHERE source_id = ?1", [id])?;
        tx.execute("DELETE FROM revisions WHERE note_id = ?1", [id])?;
        tx.commit()?;
        Ok(())
    }

    /// Inserts a revision, or replaces the time, state and value of the one
    /// with its ID when it belongs to the same note and kind. A revision for
    /// a purged or unknown note is dropped. The TypeScript adapter
    /// (src/mcp/sqlite.ts) runs the same statement.
    pub fn put_revision(&mut self, revision: &RevisionRecord) -> Result<()> {
        self.conn.execute(
            "INSERT INTO revisions (id, note_id, kind, at, ydoc, length, value)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
              WHERE EXISTS (SELECT 1 FROM notes WHERE id = ?2 AND purged_at IS NULL)
             ON CONFLICT (id) DO UPDATE SET
               at = excluded.at, ydoc = excluded.ydoc, length = excluded.length,
               value = excluded.value
             WHERE note_id = excluded.note_id AND kind = excluded.kind",
            params![
                revision.id,
                revision.note_id,
                revision.kind,
                revision.at,
                revision.ydoc,
                revision.length,
                revision.value
            ],
        )?;
        Ok(())
    }

    /// A note's revisions without their state, newest first.
    pub fn list_revisions(&self, note_id: &str) -> Result<Vec<RevisionSummary>> {
        let mut statement = self.conn.prepare_cached(REVISION_HISTORY_SQL)?;
        let rows = statement.query_map(rusqlite::named_params! { "@noteId": note_id }, |row| {
            Ok(RevisionSummary {
                id: row.get(0)?,
                note_id: row.get(1)?,
                kind: row.get(2)?,
                at: row.get(3)?,
                length: row.get(4)?,
                value: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// One revision with its state.
    pub fn get_revision(&self, id: &str) -> Result<Option<RevisionRecord>> {
        let mut statement = self.conn.prepare_cached(
            "SELECT id, note_id, kind, at, ydoc, length, value FROM revisions WHERE id = ?1",
        )?;
        Ok(statement
            .query_row([id], |row| {
                Ok(RevisionRecord {
                    id: row.get(0)?,
                    note_id: row.get(1)?,
                    kind: row.get(2)?,
                    at: row.get(3)?,
                    ydoc: row.get(4)?,
                    length: row.get(5)?,
                    value: row.get(6)?,
                })
            })
            .optional()?)
    }

    /// Deletes these revisions of a note (compaction); other notes' are kept.
    pub fn delete_revisions(&mut self, note_id: &str, ids: &[String]) -> Result<()> {
        let tx = self.conn.transaction()?;
        {
            let mut delete = tx.prepare("DELETE FROM revisions WHERE note_id = ?1 AND id = ?2")?;
            for id in ids {
                delete.execute(params![note_id, id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// The plain body versions (baselines left out) of the first `limit`
    /// notes, by ID after `after` ("" for the first), with more than one
    /// taken before `to`, one of them taken at or after `from`: what a
    /// compaction sweep weighs, a page at a time (`COMPACTABLE_SQL`).
    pub fn compactable_versions(
        &self,
        from: i64,
        to: i64,
        after: &str,
        limit: u32,
    ) -> Result<Vec<CompactableVersion>> {
        let mut statement = self.conn.prepare_cached(COMPACTABLE_SQL)?;
        let rows = statement.query_map(
            rusqlite::named_params! {
                "@from": from,
                "@to": to,
                "@after": after,
                "@limit": limit,
            },
            |row| {
                Ok(CompactableVersion {
                    note_id: row.get(0)?,
                    id: row.get(1)?,
                    at: row.get(2)?,
                })
            },
        )?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Deletes these plain body versions (an event, a baseline or an unknown
    /// ID is left alone) and, with `swept_at`, records it as the time of the
    /// last compaction sweep, in one transaction.
    pub fn compact_revisions(&mut self, ids: &[String], swept_at: Option<i64>) -> Result<()> {
        let tx = self.conn.transaction()?;
        {
            let mut delete = tx.prepare_cached(COMPACT_DROP_SQL)?;
            for id in ids {
                delete.execute(rusqlite::named_params! { "@id": id })?;
            }
        }
        if let Some(at) = swept_at {
            tx.execute(COMPACT_SWEPT_SQL, rusqlite::named_params! { "@at": at })?;
        }
        tx.commit()?;
        Ok(())
    }

    /// When the last compaction sweep ran, as `compact_revisions` recorded
    /// it; none before the first.
    pub fn last_compaction(&self) -> Result<Option<i64>> {
        Ok(self
            .conn
            .query_row(LAST_COMPACTION_SQL, [], |row| row.get(0))
            .optional()?)
    }

    /// What the activity heatmap counts from `since` on, over the notes on
    /// this device (live or in the Trash; a purged note and its revisions
    /// are gone): the notes created since then, and the body versions and
    /// title changes taken since then, each body version with the length of
    /// the one before it.
    pub fn list_activity(&self, since: i64) -> Result<ActivityData> {
        let mut notes = self.conn.prepare_cached(ACTIVITY_NOTES_SQL)?;
        let notes = notes
            .query_map(rusqlite::named_params! { "@since": since }, |row| {
                Ok(ActivityNote {
                    id: row.get(0)?,
                    created_at: row.get(1)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        let mut revisions = self.conn.prepare_cached(ACTIVITY_REVISIONS_SQL)?;
        let revisions = revisions
            .query_map(rusqlite::named_params! { "@since": since }, |row| {
                Ok(ActivityRevision {
                    note_id: row.get(0)?,
                    kind: row.get(1)?,
                    at: row.get(2)?,
                    length: row.get(3)?,
                    previous: row.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(ActivityData { notes, revisions })
    }

    /// Live notes meeting every condition of `query`, best matches first
    /// (see `search_sql`), each with its excerpt.
    pub fn search_notes(&self, query: &NoteQuery, limit: u32) -> Result<Vec<NoteSummary>> {
        let (sql, values) = search_sql(query, limit);
        let mut statement = self.conn.prepare(&sql)?;
        let rows = statement.query_map(rusqlite::params_from_iter(values.iter()), summary)?;
        let mut found: Vec<NoteSummary> = rows.collect::<rusqlite::Result<_>>()?;
        // Excerpts only for the notes returned: the body around the first
        // searched word found in it.
        let terms: Vec<&str> = query
            .text
            .iter()
            .filter(|t| !t.negate && t.field != TextField::Title)
            .map(|t| t.value.as_str())
            .collect();
        if !terms.is_empty() {
            let mut body = self
                .conn
                .prepare_cached("SELECT body_md FROM notes WHERE id = ?1")?;
            for note in &mut found {
                let text: String = body.query_row([&note.id], |row| row.get(0))?;
                note.excerpt = body_excerpt(&text, &terms);
            }
        }
        Ok(found)
    }

    /// Stores an attachment for a note that is not in the trash. Returns
    /// false (and stores nothing) when that note does not exist.
    pub fn put_file(&mut self, file: &FileRecord) -> Result<bool> {
        let tx = self.conn.transaction()?;
        let live: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM notes WHERE id = ?1 AND deleted_at IS NULL)",
            [&file.note_id],
            |row| row.get(0),
        )?;
        if live {
            tx.execute(
                "INSERT INTO files (id, note_id, name, mime, size, data, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    file.id,
                    file.note_id,
                    file.name,
                    file.mime,
                    file.data.len() as i64,
                    file.data,
                    file.created_at
                ],
            )?;
        }
        tx.commit()?;
        Ok(live)
    }

    /// Gives a note that is not in the trash copies of attachments, in one
    /// transaction: each file `from` (name, type and bytes) under the new ID
    /// `to`. A file that does not exist is skipped. Returns false (and copies
    /// nothing) when that note does not exist or is in the trash. The
    /// TypeScript adapter (src/mcp/sqlite.ts) runs the same statement.
    pub fn copy_files(&mut self, note_id: &str, copies: &[FileCopy], at: i64) -> Result<bool> {
        let tx = self.conn.transaction()?;
        let live: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM notes WHERE id = ?1 AND deleted_at IS NULL)",
            [note_id],
            |row| row.get(0),
        )?;
        if live {
            let mut copy = tx.prepare_cached(
                "INSERT INTO files (id, note_id, name, mime, size, data, created_at)
                 SELECT ?2, ?1, name, mime, size, data, ?4 FROM files WHERE id = ?3",
            )?;
            for FileCopy { from, to } in copies {
                copy.execute(params![note_id, to, from, at])?;
            }
        }
        tx.commit()?;
        Ok(live)
    }

    /// The Markdown snapshots of the live notes among `ids` (not in the
    /// trash, not purged), without their Yjs state: what the Markdown mirror
    /// writes. IDs that are not such a note are left out.
    pub fn note_bodies(&self, ids: &[String]) -> Result<Vec<(String, String)>> {
        let mut statement = self.conn.prepare_cached(
            "SELECT id, body_md FROM notes
             WHERE id IN (SELECT value FROM json_each(?1))
               AND deleted_at IS NULL AND purged_at IS NULL",
        )?;
        let ids = serde_json::to_string(ids).unwrap_or_else(|_| "[]".into());
        let rows = statement.query_map([ids], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The stored name and type of each attachment among `ids` that exists,
    /// without its bytes. IDs of no attachment are left out.
    pub fn file_names(&self, ids: &[String]) -> Result<Vec<(String, String, String)>> {
        let mut statement = self.conn.prepare_cached(
            "SELECT id, name, mime FROM files WHERE id IN (SELECT value FROM json_each(?1))",
        )?;
        let ids = serde_json::to_string(ids).unwrap_or_else(|_| "[]".into());
        let rows = statement.query_map([ids], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// An attachment, unless it was deleted with its note (see `purge_note`).
    pub fn get_file(&self, id: &str) -> Result<Option<FileRecord>> {
        let mut statement = self.conn.prepare_cached(
            "SELECT id, note_id, name, mime, data, created_at FROM files WHERE id = ?1",
        )?;
        Ok(statement
            .query_row([id], |row| {
                Ok(FileRecord {
                    id: row.get(0)?,
                    note_id: row.get(1)?,
                    name: row.get(2)?,
                    mime: row.get(3)?,
                    data: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })
            .optional()?)
    }
}

#[cfg(test)]
mod tests;
