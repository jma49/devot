use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRecord {
    pub id: String,
    pub title: String,
    pub title_hlc: String,
    pub body_md: String,
    pub ydoc: Vec<u8>,
    /// Read: the stored version; written: the one its writer last saw (see `Store::put_note`). 0
    /// for a note not written yet.
    pub body_version: i64,
    pub book_id: Option<String>,
    pub book_hlc: String,
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

/// A note's fields without its body, for a write that changed no text (`Store::put_note_meta`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteMeta {
    pub id: String,
    pub title: String,
    pub title_hlc: String,
    pub body_version: i64,
    pub book_id: Option<String>,
    pub book_hlc: String,
    pub status: String,
    pub status_hlc: String,
    pub pinned: bool,
    pub pinned_hlc: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub dates_hlc: String,
    pub deleted_at: Option<i64>,
    pub deleted_hlc: Option<String>,
}

impl NoteRecord {
    pub fn from_meta(meta: NoteMeta, body_md: String, ydoc: Vec<u8>) -> Self {
        Self {
            id: meta.id,
            title: meta.title,
            title_hlc: meta.title_hlc,
            body_md,
            ydoc,
            body_version: meta.body_version,
            book_id: meta.book_id,
            book_hlc: meta.book_hlc,
            status: meta.status,
            status_hlc: meta.status_hlc,
            pinned: meta.pinned,
            pinned_hlc: meta.pinned_hlc,
            created_at: meta.created_at,
            updated_at: meta.updated_at,
            dates_hlc: meta.dates_hlc,
            deleted_at: meta.deleted_at,
            deleted_hlc: meta.deleted_hlc,
        }
    }
}

pub const NOTE_STATUSES: [&str; 5] = ["none", "active", "on_hold", "completed", "dropped"];

/// The IDs `tags.color` may hold; each theme maps one to a colour (design tokens `color.tag.<id>`).
/// Same list as `TAG_COLORS` in src/core/storage.ts.
pub const TAG_COLORS: [&str; 8] = [
    "red", "orange", "yellow", "green", "blue", "purple", "pink", "gray",
];

/// What `tags.color` may hold: a palette ID, or a custom colour as lowercase `#rrggbb`. Same rule
/// as `isTagColorValue` in src/core/tags.ts. A notebook icon takes the palette alone.
pub fn valid_tag_color(color: &str) -> bool {
    if TAG_COLORS.contains(&color) {
        return true;
    }
    let bytes = color.as_bytes();
    bytes.len() == 7
        && bytes[0] == b'#'
        && bytes[1..]
            .iter()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

const NOTEBOOK_SYMBOLS_JSON: &str = include_str!("../../../design/icons/notebook-symbols.json");

const NOTEBOOK_LUCIDE_JSON: &str = include_str!("../../../design/icons/notebook-lucide.json");
const LUCIDE_ICON_PREFIX: &str = "lucide:";

// The catalogs ship inside the binary and a test parses them, so a failure
// here is a build mistake: no name is then accepted.
fn catalog_names(json: &str) -> std::collections::HashSet<String> {
    #[derive(Deserialize)]
    struct Catalog {
        symbols: std::collections::HashMap<String, serde_json::Value>,
    }
    serde_json::from_str::<Catalog>(json)
        .map(|c| c.symbols.into_keys().collect())
        .unwrap_or_default()
}

pub fn notebook_symbol(name: &str) -> bool {
    static NAMES: std::sync::OnceLock<std::collections::HashSet<String>> =
        std::sync::OnceLock::new();
    NAMES
        .get_or_init(|| catalog_names(NOTEBOOK_SYMBOLS_JSON))
        .contains(name)
}

/// What `books.icon` may hold: a catalog SF Symbol, or `lucide:` and a catalog Lucide name.
pub fn notebook_icon(name: &str) -> bool {
    static LUCIDE: std::sync::OnceLock<std::collections::HashSet<String>> =
        std::sync::OnceLock::new();
    notebook_symbol(name)
        || name.strip_prefix(LUCIDE_ICON_PREFIX).is_some_and(|glyph| {
            LUCIDE
                .get_or_init(|| catalog_names(NOTEBOOK_LUCIDE_JSON))
                .contains(glyph)
        })
}

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
    /// A palette ID from `TAG_COLORS` or a custom `#rrggbb`; None for no colour. Listing reads a
    /// value it does not know (from a later Devot) as None.
    #[serde(default)]
    pub color: Option<String>,
    /// Empty when the colour was never set.
    #[serde(default)]
    pub color_hlc: String,
}

/// A saved search (schema v25): a name and a query in the search field's syntax, kept as typed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSearchRecord {
    pub id: String,
    pub name: String,
    pub name_hlc: String,
    pub query: String,
    pub query_hlc: String,
    /// Orders the rows by hand (src/core/order.ts); empty for one never placed.
    pub sort_key: String,
    pub sort_key_hlc: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    pub deleted_hlc: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileRecord {
    pub id: String,
    pub note_id: String,
    pub name: String,
    pub mime: String,
    pub data: Vec<u8>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileCopy {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashedNote {
    pub id: String,
    pub title: String,
    pub deleted_at: i64,
    pub book_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteTagRecord {
    pub note_id: String,
    pub tag_id: String,
    pub present: bool,
    pub hlc: String,
}

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
    /// Allow AI Access: AI tools see the notebook's own notes (not its
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
    /// An SF Symbol name from the notebook icon catalog; None for the default icon. An unknown name
    /// (from a later catalog) reads as None.
    #[serde(default)]
    pub icon: Option<String>,
    /// A palette ID from `TAG_COLORS` the icon is drawn in; None for the text colour. An unknown ID
    /// reads as None.
    #[serde(default)]
    pub icon_color: Option<String>,
    /// One clock for the icon and its colour; empty when never set.
    #[serde(default)]
    pub icon_hlc: String,
}

pub const REVISION_KINDS: [&str; 5] = ["body", "title", "book", "status", "pinned"];

/// The body version that keeps the text a note had when its history began. The activity heatmap
/// does not count it (see `BASELINE` in src/core/revisions.ts).
pub const BASELINE: &str = "baseline";

/// The body version an accepted AI edit proposal wrote: like a baseline, kept by compaction and not
/// counted by the heatmap (see `AI_EDIT` in src/core/revisions.ts).
pub const AI_EDIT: &str = "ai";
/// The body version kept before a state from another device changed the note (`MERGE` in
/// src/core/revisions.ts); compaction keeps it.
pub const MERGE: &str = "merge";

/// Local to this device. A body version holds the Yjs state and its text length; an event holds the
/// new value of the field (see migrations/0009_revisions.sql).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionRecord {
    pub id: String,
    pub note_id: String,
    pub kind: String,
    pub at: i64,
    pub ydoc: Option<Vec<u8>>,
    pub length: Option<i64>,
    pub value: Option<String>,
    /// `None` for an event and for a version taken before schema v24.
    #[serde(default)]
    pub words: Option<i64>,
}

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactableVersion {
    pub note_id: String,
    pub id: String,
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityNote {
    pub id: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRevision {
    pub note_id: String,
    pub kind: String,
    pub at: i64,
    pub length: Option<i64>,
    pub words: Option<i64>,
    pub previous: Option<i64>,
    pub previous_words: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivityData {
    pub notes: Vec<ActivityNote>,
    pub revisions: Vec<ActivityRevision>,
}

/// A note's row of the agent_writes index (docs/adr/0007-authorship-by-yjs-item-ids.md), as the
/// core derives it from the authorship records in the note's Yjs state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWriteRow {
    pub write_id: String,
    pub kind: String,
    pub name: String,
    pub at: i64,
    pub created: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWriteSummary {
    pub note_id: String,
    pub write_id: String,
    pub kind: String,
    pub name: String,
    pub at: i64,
    pub created: bool,
    pub seen: bool,
}

/// What a list row reads from a note: its title and Markdown body, never its Yjs state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteBody {
    pub id: String,
    pub title: String,
    pub body_md: String,
}

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
    pub tag_ids: Vec<String>,
    /// The stored body's version; it moves with every write of the note.
    pub body_version: i64,
    /// Search results only: the body around the first searched word found
    /// there, starting with an ellipsis when it starts mid-body.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NoteQuery {
    pub text: Vec<TextCondition>,
    pub sets: Vec<SetCondition>,
    pub pinned: Option<bool>,
}

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
    Any,
    Title,
    Body,
}

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
