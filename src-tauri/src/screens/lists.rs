//! The native lists' reads (docs/specs/iphone-screens.md, Rust-direct operations): note rows, the
//! Library and the Trash, from the same `Store` reads the Tauri list commands run. `Db::call`
//! lends a `&Store` only, so nothing here can write.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::commands::notes::valid_note_id;
use crate::storage::{BookRecord, Db, NoteSummary, Store, TrashedNote};

/// `TEMPLATES_BOOK_ID` in src/core/templatesBook.ts, which a policy test holds this to.
pub const TEMPLATES_BOOK_ID: &str = "00000000-0000-7000-8000-000000000001";
/// The first page a list paints; the rest follow in pages of the same size.
pub const PAGE_ROWS: u32 = 200;
const MAX_PAGE_ROWS: u32 = 1_000;
/// The most notes one titles read names: the editors of every tab's stack.
pub const MAX_TITLE_IDS: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum View {
    All {},
    Pinned {},
    Book { id: String },
    Tag { id: String },
    Templates {},
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    #[default]
    All,
    Active,
    OnHold,
    Completed,
}

impl Status {
    fn admits(self, status: &str) -> bool {
        match self {
            Self::All => true,
            Self::Active => status == "active",
            Self::OnHold => status == "on_hold",
            Self::Completed => status == "completed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Page {
    pub view: View,
    #[serde(default)]
    pub status: Status,
    #[serde(default)]
    pub offset: u32,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Rows {
    pub rows: Vec<NoteSummary>,
    /// How many rows the view holds in all, for the pages still to read.
    pub total: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub all: usize,
    pub pinned: usize,
    pub active: usize,
    pub on_hold: usize,
    pub completed: usize,
    pub templates: usize,
    pub trash: usize,
}

/// A live notebook in the Library's order: each one after its parent, siblings by sort key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    pub id: String,
    pub name: String,
    /// Shown under the top level when its parent is missing, as the page shows it.
    pub parent_id: Option<String>,
    pub icon: Option<String>,
    pub icon_color: Option<String>,
    /// Its own notes and its descendants'.
    pub count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSearch {
    pub id: String,
    pub name: String,
    pub query: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ids {
    pub ids: Vec<String>,
}

/// A live note's title, for an editor rebuilt from a link or a restored stack.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Title {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub counts: Counts,
    pub books: Vec<Book>,
    pub tags: Vec<Tag>,
    pub saved_searches: Vec<SavedSearch>,
}

/// The reads, over the app's database.
#[derive(Clone)]
pub struct Reads(Db);

impl Reads {
    pub fn of(db: &Db) -> Self {
        Self(db.clone())
    }

    pub async fn notes(&self, page: Page) -> Result<Rows, &'static str> {
        check(&page)?;
        self.0
            .call(move |store| rows(store, &page))
            .await
            .map_err(|error| error.code())
    }

    pub async fn library(&self) -> Result<Library, &'static str> {
        self.0.call(library).await.map_err(|error| error.code())
    }

    /// The titles of those of `ids` that are live notes, in the order asked; a note in the Trash
    /// or gone has none.
    pub async fn titles(&self, ids: Ids) -> Result<Vec<Title>, &'static str> {
        if ids.ids.len() > MAX_TITLE_IDS || !ids.ids.iter().all(|id| valid_note_id(id)) {
            return Err("E_SCREENS_ARGS_INVALID");
        }
        self.0
            .call(move |store| titles(store, &ids.ids))
            .await
            .map_err(|error| error.code())
    }

    pub async fn trash(&self) -> Result<Vec<TrashedNote>, &'static str> {
        self.0
            .call(Store::list_trash)
            .await
            .map_err(|error| error.code())
    }
}

fn check(page: &Page) -> Result<(), &'static str> {
    if let View::Book { id } | View::Tag { id } = &page.view
        && !valid_note_id(id)
    {
        return Err("E_SCREENS_ARGS_INVALID");
    }
    if page
        .limit
        .is_some_and(|limit| limit == 0 || limit > MAX_PAGE_ROWS)
    {
        return Err("E_SCREENS_ARGS_INVALID");
    }
    Ok(())
}

fn live_books(store: &Store) -> crate::storage::Result<Vec<BookRecord>> {
    Ok(store
        .list_books()?
        .into_iter()
        .filter(|book| book.deleted_at.is_none() && book.id != TEMPLATES_BOOK_ID)
        .collect())
}

/// The live notebooks as a tree, a missing parent's children at the top.
fn children(books: &[BookRecord]) -> HashMap<Option<&str>, Vec<&BookRecord>> {
    let known: HashSet<&str> = books.iter().map(|book| book.id.as_str()).collect();
    let mut tree: HashMap<Option<&str>, Vec<&BookRecord>> = HashMap::new();
    for book in books {
        let parent = book.parent_id.as_deref().filter(|id| known.contains(id));
        tree.entry(parent).or_default().push(book);
    }
    for siblings in tree.values_mut() {
        siblings.sort_by(|a, b| a.sort_key.cmp(&b.sort_key).then_with(|| a.id.cmp(&b.id)));
    }
    tree
}

fn with_descendants<'a>(
    id: &'a str,
    tree: &HashMap<Option<&'a str>, Vec<&'a BookRecord>>,
) -> HashSet<&'a str> {
    let mut found = HashSet::from([id]);
    let mut next = vec![id];
    while let Some(at) = next.pop() {
        for child in tree.get(&Some(at)).into_iter().flatten() {
            if found.insert(child.id.as_str()) {
                next.push(child.id.as_str());
            }
        }
    }
    found
}

fn rows(store: &Store, page: &Page) -> crate::storage::Result<Rows> {
    let notes = store.list_notes_page(None, None)?;
    let books = match page.view {
        View::Book { .. } => live_books(store)?,
        _ => Vec::new(),
    };
    let tree = children(&books);
    let shelf = match &page.view {
        View::Book { id } => with_descendants(id, &tree),
        _ => HashSet::new(),
    };
    let in_view = |note: &NoteSummary| {
        let template = note.book_id.as_deref() == Some(TEMPLATES_BOOK_ID);
        match &page.view {
            View::Templates {} => template,
            _ if template => false,
            View::All {} => true,
            View::Pinned {} => note.pinned,
            View::Book { .. } => note.book_id.as_deref().is_some_and(|id| shelf.contains(id)),
            View::Tag { id } => note.tag_ids.contains(id),
        }
    };
    let found: Vec<NoteSummary> = notes
        .into_iter()
        .filter(|note| in_view(note) && page.status.admits(&note.status))
        .collect();
    let total = found.len();
    let limit = page.limit.unwrap_or(PAGE_ROWS) as usize;
    Ok(Rows {
        rows: found
            .into_iter()
            .skip(page.offset as usize)
            .take(limit)
            .collect(),
        total,
    })
}

fn titles(store: &Store, ids: &[String]) -> crate::storage::Result<Vec<Title>> {
    let notes: HashMap<String, String> = store
        .list_notes_page(None, None)?
        .into_iter()
        .map(|note| (note.id, note.title))
        .collect();
    Ok(ids
        .iter()
        .filter_map(|id| {
            notes.get(id).map(|title| Title {
                id: id.clone(),
                title: title.clone(),
            })
        })
        .collect())
}

fn library(store: &Store) -> crate::storage::Result<Library> {
    let notes = store.list_notes_page(None, None)?;
    let books = live_books(store)?;
    let tree = children(&books);
    let (templates, notes): (Vec<_>, Vec<_>) = notes
        .into_iter()
        .partition(|note| note.book_id.as_deref() == Some(TEMPLATES_BOOK_ID));
    let count = |status: &str| notes.iter().filter(|note| note.status == status).count();
    let counts = Counts {
        all: notes.len(),
        pinned: notes.iter().filter(|note| note.pinned).count(),
        active: count("active"),
        on_hold: count("on_hold"),
        completed: count("completed"),
        templates: templates.len(),
        trash: store.list_trash()?.len(),
    };
    let mut own: HashMap<&str, usize> = HashMap::new();
    for note in &notes {
        if let Some(book) = note.book_id.as_deref() {
            *own.entry(book).or_default() += 1;
        }
    }
    let mut ordered = Vec::new();
    let mut seen = HashSet::new();
    let mut stack: Vec<&BookRecord> = tree
        .get(&None)
        .into_iter()
        .flatten()
        .rev()
        .copied()
        .collect();
    while let Some(book) = stack.pop() {
        if !seen.insert(book.id.as_str()) {
            continue;
        }
        let shelf = with_descendants(&book.id, &tree);
        ordered.push(Book {
            id: book.id.clone(),
            name: book.name.clone(),
            parent_id: book
                .parent_id
                .clone()
                .filter(|id| books.iter().any(|b| &b.id == id)),
            icon: book.icon.clone(),
            icon_color: book.icon_color.clone(),
            count: shelf
                .iter()
                .map(|id| own.get(id).copied().unwrap_or(0))
                .sum(),
        });
        stack.extend(
            tree.get(&Some(book.id.as_str()))
                .into_iter()
                .flatten()
                .rev(),
        );
    }
    let mut per_tag: HashMap<&str, usize> = HashMap::new();
    for note in &notes {
        for id in note.tag_ids.iter().collect::<HashSet<_>>() {
            *per_tag.entry(id.as_str()).or_default() += 1;
        }
    }
    let tags = store
        .list_tags()?
        .into_iter()
        .filter(|tag| tag.deleted_at.is_none())
        .map(|tag| Tag {
            count: per_tag.get(tag.id.as_str()).copied().unwrap_or(0),
            id: tag.id,
            name: tag.name,
            color: tag.color,
        })
        .collect();
    let saved_searches = store
        .list_saved_searches()?
        .into_iter()
        .filter(|search| search.deleted_at.is_none())
        .map(|search| SavedSearch {
            id: search.id,
            name: search.name,
            query: search.query,
        })
        .collect();
    Ok(Library {
        counts,
        books: ordered,
        tags,
        saved_searches,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::storage::{NoteRecord, NoteTagRecord, TagRecord, Write};

    const BOOK: &str = "01890a5d-ac96-774b-bcce-b30209900001";
    const SHELF: &str = "01890a5d-ac96-774b-bcce-b30209900002";
    const TAG: &str = "01890a5d-ac96-774b-bcce-b30209900003";

    fn id(n: u32) -> String {
        format!("01890a5d-ac96-774b-bcce-{n:012}")
    }

    fn hlc(at: i64) -> String {
        format!("{at:016}-0000-test")
    }

    fn note(n: u32, at: i64) -> NoteRecord {
        NoteRecord {
            id: id(n),
            title: format!("Note {n}"),
            title_hlc: hlc(at),
            body_md: String::new(),
            ydoc: vec![1, 2, 3],
            body_version: 0,
            book_id: None,
            book_hlc: String::new(),
            status: "none".into(),
            status_hlc: String::new(),
            pinned: false,
            pinned_hlc: String::new(),
            created_at: 1,
            updated_at: at,
            dates_hlc: String::new(),
            deleted_at: None,
            deleted_hlc: None,
        }
    }

    fn book(id: &str, parent: Option<&str>, key: &str) -> BookRecord {
        BookRecord {
            id: id.into(),
            name: id[id.len() - 1..].into(),
            name_hlc: hlc(1),
            parent_id: parent.map(String::from),
            parent_hlc: hlc(1),
            created_at: 1,
            updated_at: 1,
            deleted_at: None,
            deleted_hlc: None,
            ai_access: false,
            ai_access_hlc: String::new(),
            sort_key: key.into(),
            sort_key_hlc: hlc(1),
            icon: None,
            icon_color: None,
            icon_hlc: String::new(),
        }
    }

    struct Library {
        reads: Reads,
        _dir: tempfile::TempDir,
    }

    fn block_on<T>(work: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(work)
    }

    /// Five plain notes, two in a notebook and its child, one tagged, one completed, one pinned,
    /// a template and a trashed note.
    fn library() -> Library {
        let dir = tempfile::tempdir().expect("temp dir");
        let db = Db::spawn(&dir.path().join("devot.sqlite")).expect("database");
        block_on(db.write(Write::Content, |store| {
            store.put_books(&[book(BOOK, None, "b"), book(SHELF, Some(BOOK), "a")])?;
            store.put_tag(&TagRecord {
                id: TAG.into(),
                name: "work".into(),
                name_hlc: hlc(1),
                created_at: 1,
                updated_at: 1,
                deleted_at: None,
                deleted_hlc: None,
                color: None,
                color_hlc: String::new(),
            })?;
            for n in 1..=5 {
                store.put_note(&note(n, 100 + i64::from(n)), &[])?;
            }
            store.put_note(
                &NoteRecord {
                    book_id: Some(BOOK.into()),
                    book_hlc: hlc(2),
                    ..note(6, 50)
                },
                &[],
            )?;
            store.put_note(
                &NoteRecord {
                    book_id: Some(SHELF.into()),
                    book_hlc: hlc(2),
                    ..note(7, 40)
                },
                &[],
            )?;
            store.put_note(
                &NoteRecord {
                    status: "completed".into(),
                    status_hlc: hlc(2),
                    ..note(8, 30)
                },
                &[],
            )?;
            store.put_note(
                &NoteRecord {
                    pinned: true,
                    pinned_hlc: hlc(2),
                    ..note(9, 20)
                },
                &[],
            )?;
            store.put_note(
                &NoteRecord {
                    book_id: Some(TEMPLATES_BOOK_ID.into()),
                    book_hlc: hlc(2),
                    ..note(10, 500)
                },
                &[],
            )?;
            store.put_note(
                &NoteRecord {
                    deleted_at: Some(9),
                    deleted_hlc: Some(hlc(9)),
                    ..note(11, 10)
                },
                &[],
            )?;
            store.put_note_tag(&NoteTagRecord {
                note_id: id(2),
                tag_id: TAG.into(),
                present: true,
                hlc: hlc(3),
            })?;
            Ok(())
        }))
        .expect("seeded");
        Library {
            reads: Reads::of(&db),
            _dir: dir,
        }
    }

    fn page(args: serde_json::Value) -> Page {
        serde_json::from_value(args).expect("page")
    }

    fn ids(rows: &Rows) -> Vec<String> {
        rows.rows.iter().map(|row| row.id.clone()).collect()
    }

    #[test]
    fn lists_live_notes_newest_first_in_pages_without_templates_or_the_trash() {
        let library = library();
        let first = block_on(
            library
                .reads
                .notes(page(json!({ "view": { "kind": "all" }, "limit": 3 }))),
        )
        .unwrap();
        assert_eq!(ids(&first), [id(5), id(4), id(3)]);
        assert_eq!(first.total, 9);
        let rest = block_on(
            library
                .reads
                .notes(page(json!({ "view": { "kind": "all" }, "offset": 3 }))),
        )
        .unwrap();
        assert_eq!(ids(&rest), [2, 1, 6, 7, 8, 9].map(id));
        let templates = block_on(
            library
                .reads
                .notes(page(json!({ "view": { "kind": "templates" } }))),
        )
        .unwrap();
        assert_eq!(ids(&templates), [id(10)]);
    }

    #[test]
    fn filters_by_status_pin_tag_and_notebook_with_its_descendants() {
        let library = library();
        let view = |args| block_on(library.reads.notes(page(args))).map(|rows| ids(&rows));
        assert_eq!(
            view(json!({ "view": { "kind": "all" }, "status": "completed" })),
            Ok(vec![id(8)])
        );
        assert_eq!(
            view(json!({ "view": { "kind": "all" }, "status": "on_hold" })),
            Ok(vec![])
        );
        assert_eq!(
            view(json!({ "view": { "kind": "pinned" } })),
            Ok(vec![id(9)])
        );
        assert_eq!(
            view(json!({ "view": { "kind": "tag", "id": TAG } })),
            Ok(vec![id(2)])
        );
        assert_eq!(
            view(json!({ "view": { "kind": "book", "id": BOOK } })),
            Ok(vec![id(6), id(7)])
        );
        assert_eq!(
            view(json!({ "view": { "kind": "book", "id": SHELF } })),
            Ok(vec![id(7)])
        );
    }

    #[test]
    fn refuses_a_page_with_a_bad_id_or_size_before_reading() {
        let library = library();
        for args in [
            json!({ "view": { "kind": "book", "id": "../devot.sqlite" } }),
            json!({ "view": { "kind": "all" }, "limit": 0 }),
            json!({ "view": { "kind": "all" }, "limit": 1001 }),
        ] {
            assert_eq!(
                block_on(library.reads.notes(page(args))).map(|_| ()),
                Err("E_SCREENS_ARGS_INVALID")
            );
        }
        for args in [
            json!({ "view": { "kind": "trash" } }),
            json!({ "view": { "kind": "all" }, "status": "none" }),
            json!({ "view": { "kind": "all", "id": TAG } }),
        ] {
            assert!(serde_json::from_value::<Page>(args).is_err());
        }
    }

    #[test]
    fn the_library_counts_notebooks_with_their_descendants_in_tree_order() {
        let library = library();
        let shown = block_on(library.reads.library()).unwrap();
        assert_eq!(
            shown.counts,
            Counts {
                all: 9,
                pinned: 1,
                active: 0,
                on_hold: 0,
                completed: 1,
                templates: 1,
                trash: 1
            }
        );
        let books: Vec<(&str, Option<&str>, usize)> = shown
            .books
            .iter()
            .map(|b| (b.id.as_str(), b.parent_id.as_deref(), b.count))
            .collect();
        assert_eq!(books, [(BOOK, None, 2), (SHELF, Some(BOOK), 1)]);
        assert_eq!(
            shown
                .tags
                .iter()
                .map(|t| (t.name.as_str(), t.count))
                .collect::<Vec<_>>(),
            [("work", 1)]
        );
    }

    /// Every object's fields, at every depth, as `fixture` holds them; an empty list or a value
    /// matches anything.
    fn same_shape(fixture: &serde_json::Value, reply: &serde_json::Value, at: &str) {
        use serde_json::Value;
        match (fixture, reply) {
            (Value::Object(want), Value::Object(got)) => {
                let mut want_keys: Vec<&String> = want.keys().collect();
                let mut got_keys: Vec<&String> = got.keys().collect();
                want_keys.sort();
                got_keys.sort();
                assert_eq!(want_keys, got_keys, "fields at {at}");
                for (key, value) in want {
                    same_shape(value, &got[key], &format!("{at}.{key}"));
                }
            }
            (Value::Array(want), Value::Array(got)) => {
                if let (Some(want), Some(got)) = (want.first(), got.first()) {
                    same_shape(want, got, &format!("{at}[0]"));
                }
            }
            _ => {}
        }
    }

    #[test]
    fn the_replies_have_the_shape_of_the_rows_fixture_swift_decodes() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/screens/rows.json");
        let fixture: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).expect("E_TEST_FIXTURES"))
                .expect("E_TEST_FIXTURES");
        let library = library();
        let notes = block_on(
            library
                .reads
                .notes(page(json!({ "view": { "kind": "all" } }))),
        );
        let shown = block_on(library.reads.library()).unwrap();
        let trash = block_on(library.reads.trash()).unwrap();
        same_shape(&fixture["notes"], &json!(notes.unwrap()), "notes");
        same_shape(&fixture["library"], &json!(shown), "library");
        same_shape(&fixture["trash"], &json!(trash), "trash");
    }

    #[test]
    fn the_trash_lists_the_trashed_note() {
        let library = library();
        let trash = block_on(library.reads.trash()).unwrap();
        assert_eq!(
            trash.iter().map(|n| n.id.clone()).collect::<Vec<_>>(),
            [id(11)]
        );
    }

    #[test]
    fn titles_name_live_notes_only_in_the_order_asked() {
        let library = library();
        let titles = |ids: Vec<String>| block_on(library.reads.titles(Ids { ids }));
        assert_eq!(
            titles(vec![id(3), id(11), id(42), id(10), id(1)]),
            Ok(vec![
                Title {
                    id: id(3),
                    title: "Note 3".into()
                },
                Title {
                    id: id(10),
                    title: "Note 10".into()
                },
                Title {
                    id: id(1),
                    title: "Note 1".into()
                },
            ])
        );
        assert_eq!(titles(vec!["inbox".into()]), Err("E_SCREENS_ARGS_INVALID"));
        assert_eq!(
            titles((0..=MAX_TITLE_IDS as u32).map(id).collect()),
            Err("E_SCREENS_ARGS_INVALID")
        );
        assert_eq!(titles(Vec::new()), Ok(Vec::new()));
    }
}
