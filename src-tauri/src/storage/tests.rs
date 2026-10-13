use super::*;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn note(id: &str, title: &str, updated_at: i64) -> NoteRecord {
    NoteRecord {
        id: id.into(),
        title: title.into(),
        title_hlc: format!("{updated_at:013}-0000-test"),
        body_md: format!("# {title}\n"),
        ydoc: vec![1, 2, 3, updated_at as u8],
        body_version: 0,
        book_id: None,
        book_hlc: String::new(),
        status: "none".into(),
        status_hlc: String::new(),
        pinned: false,
        pinned_hlc: String::new(),
        created_at: 1,
        updated_at,
        dates_hlc: String::new(),
        deleted_at: None,
        deleted_hlc: None,
    }
}

fn book(id: &str, name: &str, hlc: &str) -> BookRecord {
    BookRecord {
        id: id.into(),
        name: name.into(),
        name_hlc: hlc.into(),
        parent_id: None,
        parent_hlc: hlc.into(),
        created_at: 1,
        updated_at: 1,
        deleted_at: None,
        deleted_hlc: None,
        ai_access: false,
        ai_access_hlc: String::new(),
        sort_key: "a0".into(),
        sort_key_hlc: hlc.into(),
    }
}

fn version(id: &str, note_id: &str, at: i64, ydoc: &[u8]) -> RevisionRecord {
    RevisionRecord {
        id: id.into(),
        note_id: note_id.into(),
        kind: "body".into(),
        at,
        ydoc: Some(ydoc.to_vec()),
        length: Some(ydoc.len() as i64),
        value: None,
    }
}

fn event(id: &str, note_id: &str, kind: &str, at: i64, value: Option<&str>) -> RevisionRecord {
    RevisionRecord {
        id: id.into(),
        note_id: note_id.into(),
        kind: kind.into(),
        at,
        ydoc: None,
        length: None,
        value: value.map(String::from),
    }
}

/// A search for notes whose title or body contains every term.
fn words(terms: &[&str]) -> NoteQuery {
    NoteQuery {
        text: terms
            .iter()
            .map(|t| TextCondition {
                field: TextField::Any,
                value: t.to_string(),
                negate: false,
            })
            .collect(),
        sets: Vec::new(),
        pinned: false,
    }
}

fn temp_store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().expect("temp dir");
    let store = Store::open(&dir.path().join("devot.sqlite")).expect("open");
    (dir, store)
}

#[test]
fn migrates_a_new_database_to_the_current_schema() {
    let (_dir, store) = temp_store();
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    assert!(store.integrity_ok().unwrap());
}

#[test]
fn reopening_does_not_reapply_migrations() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("devot.sqlite");
    let mut store = Store::open(&path).unwrap();
    store.put_note(&note("a", "Kept", 10), &[]).unwrap();
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    assert_eq!(store.list_notes().unwrap().len(), 1);
}

#[test]
fn refuses_a_database_from_a_newer_pen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("devot.sqlite");
    drop(Store::open(&path).unwrap());
    let conn = Connection::open(&path).unwrap();
    conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1)
        .unwrap();
    drop(conn);
    assert!(matches!(
        Store::open(&path),
        Err(StorageError::NewerSchema(_))
    ));
}

/// The code a SQLite failure is reported and logged with.
fn code(error: rusqlite::Error) -> String {
    StorageError::from(error).to_string()
}

#[test]
fn sqlite_failures_keep_their_kind_in_the_code() {
    let dir = tempfile::tempdir().unwrap();
    // Busy: another connection holds the write lock, and this one does not wait.
    let path = dir.path().join("busy.sqlite");
    let holder = Connection::open(&path).unwrap();
    holder
        .execute_batch("CREATE TABLE t(x); BEGIN IMMEDIATE; INSERT INTO t VALUES (1);")
        .unwrap();
    let waiting = Connection::open(&path).unwrap();
    waiting.busy_timeout(Duration::ZERO).unwrap();
    let busy = waiting.execute_batch("BEGIN IMMEDIATE").unwrap_err();
    assert_eq!(code(busy), "E_STORAGE_BUSY");
    drop(holder);
    // Read-only: a connection that may not write.
    let read_only = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let error = read_only
        .execute("INSERT INTO t VALUES (2)", [])
        .unwrap_err();
    assert_eq!(code(error), "E_STORAGE_READONLY");
    // Full: the file may not grow any more.
    let full = Connection::open(dir.path().join("full.sqlite")).unwrap();
    full.execute_batch("CREATE TABLE t(x); PRAGMA max_page_count = 3;")
        .unwrap();
    let error = full
        .execute("INSERT INTO t VALUES (zeroblob(100000))", [])
        .unwrap_err();
    assert_eq!(code(error), "E_STORAGE_FULL");
    // Corrupt: a file that is not a database, also when the store opens it.
    let not_a_database = dir.path().join("devot.sqlite");
    std::fs::write(&not_a_database, "buy oat milk ".repeat(512)).unwrap();
    let error = Connection::open(&not_a_database)
        .unwrap()
        .execute_batch("SELECT * FROM sqlite_master")
        .unwrap_err();
    assert_eq!(code(error), "E_STORAGE_CORRUPT");
    let opened = Store::open(&not_a_database).err().unwrap();
    assert_eq!(opened.to_string(), "E_STORAGE_CORRUPT");
    // Cannot open: the file cannot be made or opened where it should be (a
    // folder that is missing or may not be written).
    let error = Connection::open(dir.path().join("missing").join("devot.sqlite")).unwrap_err();
    assert_eq!(code(error), "E_STORAGE_CANTOPEN");
    // An I/O failure comes from the disk itself; it is not made here.
    let io = rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_IOERR_WRITE),
        None,
    );
    assert_eq!(code(io), "E_STORAGE_IO");
    // Anything else keeps the general code; SQLite's message, which can
    // quote the statement or its data, never shows.
    let other = Connection::open_in_memory()
        .unwrap()
        .execute_batch("SELECT * FROM \"Grocery list\"")
        .unwrap_err();
    assert_eq!(code(other), "E_STORAGE_SQLITE");
    assert_eq!(code(rusqlite::Error::InvalidQuery), "E_STORAGE_SQLITE");
}

#[test]
fn upgrades_the_schema_v1_fixture() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("devot.sqlite");
    let fixture = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/schema-v1.sqlite"
    );
    std::fs::copy(fixture, &path).unwrap();
    let store = Store::open(&path).unwrap();
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    let fixture_note = store
        .get_note("0192a6f0-0000-7000-8000-000000000001", false)
        .unwrap()
        .expect("fixture note survives the upgrade");
    assert_eq!(fixture_note.title, "Fixture note");
    assert_eq!(fixture_note.book_id, None, "v1 notes are in no notebook");
    assert_eq!(
        fixture_note.body_version, 0,
        "a body from before body versions is at version 0"
    );
    assert!(store.list_books().unwrap().is_empty());
}

#[test]
fn round_trips_a_note() {
    let (_dir, mut store) = temp_store();
    let original = note("a", "First", 10);
    store.put_note(&original, &[]).unwrap();
    // Stored with its body at the next version.
    assert_eq!(
        store.get_note("a", false).unwrap(),
        Some(based_on(1, original))
    );
    assert_eq!(store.get_note("missing", false).unwrap(), None);
}

#[test]
fn put_replaces_an_existing_note_but_keeps_created_at() {
    let (_dir, mut store) = temp_store();
    store.put_note(&note("a", "Old", 10), &[]).unwrap();
    let mut newer = based_on(1, note("a", "New", 20));
    newer.created_at = 999;
    store.put_note(&newer, &[]).unwrap();
    let stored = store.get_note("a", false).unwrap().unwrap();
    assert_eq!(stored.title, "New");
    assert_eq!(stored.created_at, 1, "created_at is set once");
}

#[test]
fn hand_set_dates_with_a_newer_hlc_replace_both_dates() {
    let (_dir, mut store) = temp_store();
    store.put_note(&note("a", "A", 50), &[]).unwrap();
    let mut set = based_on(1, note("a", "A", 50));
    set.created_at = 5;
    set.updated_at = 20;
    set.dates_hlc = "0000000000060-0000-test".into();
    store.put_note(&set, &[]).unwrap();
    let stored = store.get_note("a", false).unwrap().unwrap();
    assert_eq!((stored.created_at, stored.updated_at), (5, 20));

    // A stale write (older dates HLC) keeps them; its update time only moves on.
    let mut stale = based_on(2, note("a", "A", 30));
    stale.created_at = 1;
    store.put_note(&stale, &[]).unwrap();
    let stored = store.get_note("a", false).unwrap().unwrap();
    assert_eq!((stored.created_at, stored.updated_at), (5, 30));
    assert_eq!(stored.dates_hlc, "0000000000060-0000-test");
}

#[test]
fn lists_live_notes_newest_first_and_hides_the_trash() {
    let (_dir, mut store) = temp_store();
    store.put_note(&note("old", "Old", 10), &[]).unwrap();
    store.put_note(&note("new", "New", 30), &[]).unwrap();
    let mut trashed = note("gone", "Gone", 20);
    trashed.deleted_at = Some(25);
    trashed.deleted_hlc = Some("0000000000025-0000-test".into());
    store.put_note(&trashed, &[]).unwrap();

    let ids: Vec<_> = store
        .list_notes()
        .unwrap()
        .into_iter()
        .map(|n| n.id)
        .collect();
    assert_eq!(ids, ["new", "old"]);
    assert_eq!(store.get_note("gone", false).unwrap(), None);
}

#[test]
fn listed_and_found_notes_carry_their_creation_time() {
    let (_dir, mut store) = temp_store();
    let mut a = note("a", "Groceries", 30);
    a.created_at = 7;
    store.put_note(&a, &[]).unwrap();
    let listed = &store.list_notes().unwrap()[0];
    assert_eq!((listed.created_at, listed.updated_at), (7, 30));
    let found = &store.search_notes(&words(&["Groceries"]), 10).unwrap()[0];
    assert_eq!((found.created_at, found.updated_at), (7, 30));
    let short = &store.search_notes(&words(&["gr"]), 10).unwrap()[0];
    assert_eq!(short.created_at, 7);
}

#[test]
fn keeps_the_newer_value_of_each_note_field() {
    let (_dir, mut store) = temp_store();
    let mut newer = note("a", "New title", 30);
    newer.title_hlc = "0000000000000030-0000-a".into();
    newer.book_id = Some("book-2".into());
    newer.book_hlc = "0000000000000030-0000-a".into();
    store.put_note(&newer, &[]).unwrap();

    // A stale copy: older title and notebook, newer body (written over the
    // body as stored).
    let mut stale = based_on(1, note("a", "Old title", 40));
    stale.title_hlc = "0000000000000010-0000-a".into();
    stale.book_id = Some("book-1".into());
    stale.book_hlc = "0000000000000010-0000-a".into();
    store.put_note(&stale, &[]).unwrap();

    let stored = store.get_note("a", false).unwrap().unwrap();
    assert_eq!(stored.title, "New title");
    assert_eq!(stored.book_id.as_deref(), Some("book-2"));
    assert_eq!(
        stored.body_md, stale.body_md,
        "the body is written as given"
    );
    assert_eq!(stored.updated_at, 40);
    assert_eq!(
        store.list_notes().unwrap()[0].book_id.as_deref(),
        Some("book-2")
    );
}

/// `note` written over body version `version`.
fn based_on(version: i64, note: NoteRecord) -> NoteRecord {
    NoteRecord {
        body_version: version,
        ..note
    }
}

#[test]
fn moves_the_body_version_on_with_each_write_based_on_it() {
    let (_dir, mut store) = temp_store();
    store.put_note(&note("a", "A", 10), &[]).unwrap();
    assert_eq!(store.get_note("a", false).unwrap().unwrap().body_version, 1);
    store
        .put_note(&based_on(1, note("a", "A", 11)), &[])
        .unwrap();
    assert_eq!(store.get_note("a", false).unwrap().unwrap().body_version, 2);
    // In the Trash too.
    let trashed = in_trash(based_on(2, note("a", "A", 12)), 12);
    store.put_note(&trashed, &[]).unwrap();
    assert_eq!(store.get_note("a", true).unwrap().unwrap().body_version, 3);
}

#[test]
fn refuses_a_write_based_on_another_body_version_and_leaves_a_purged_note_alone() {
    let (_dir, mut store) = temp_store();
    store.put_note(&note("a", "A", 10), &["b".into()]).unwrap();
    store
        .put_note(&based_on(1, note("a", "A", 11)), &["b".into()])
        .unwrap();
    let before = store.get_note("a", false).unwrap().unwrap();

    // Based on version 1, which a write has moved on from: refused whole,
    // its newer title and pin and its links with it.
    let mut stale = based_on(1, note("a", "Late", 12));
    stale.title_hlc = "0000000000000099-0000-test".into();
    stale.pinned = true;
    stale.pinned_hlc = "0000000000000099-0000-test".into();
    let refused = store.put_note(&stale, &["c".into()]).unwrap_err();
    assert_eq!(refused.to_string(), "E_NOTE_BODY_STALE");
    // Based on a version storage never had.
    let ahead = based_on(7, note("a", "A", 13));
    let refused = store.put_note(&ahead, &[]).unwrap_err();
    assert_eq!(refused.to_string(), "E_NOTE_BODY_STALE");
    assert_eq!(store.get_note("a", false).unwrap(), Some(before));
    assert_eq!(link_rows(&store), [("a".to_string(), "b".to_string())]);

    // A purge is final: a write to a purged note is left alone, whatever its version.
    store
        .purge_note("a", 20, "0000000000000020-0000-test")
        .unwrap();
    for version in [0, 2, 3] {
        store
            .put_note(&based_on(version, note("a", "Revived", 30)), &[])
            .unwrap();
    }
    assert_eq!(store.get_note("a", true).unwrap(), None);
}

#[test]
fn a_body_written_on_another_connection_makes_a_write_based_on_the_one_before_stale() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("devot.sqlite");
    let mut window = Store::open(&path).unwrap();
    let mut other = Store::open(&path).unwrap();
    window.put_note(&note("a", "A", 10), &[]).unwrap();

    // The window reads the note; the other connection writes it before the
    // window's write lands.
    let read = window.get_note("a", false).unwrap().unwrap();
    let theirs = other.get_note("a", false).unwrap().unwrap();
    let theirs = NoteRecord {
        body_md: "middle end".into(),
        ..theirs
    };
    other.put_note(&theirs, &[]).unwrap();
    let mine = NoteRecord {
        body_md: "start middle".into(),
        ..read
    };
    let refused = window.put_note(&mine, &[]).unwrap_err();
    assert_eq!(refused.to_string(), "E_NOTE_BODY_STALE");
    let stored = window.get_note("a", false).unwrap().unwrap();
    assert_eq!(stored.body_md, "middle end");

    // After taking that in, the window writes again, based on it.
    let merged = NoteRecord {
        body_md: "start middle end".into(),
        ..stored
    };
    window.put_note(&merged, &[]).unwrap();
    let stored = window.get_note("a", false).unwrap().unwrap();
    assert_eq!(
        (stored.body_md.as_str(), stored.body_version),
        ("start middle end", 3)
    );
}

#[test]
fn stores_notebooks_and_merges_them_per_field() {
    let (_dir, mut store) = temp_store();
    store
        .put_book(&book("b1", "Work", "0000000000000010-0000-a"))
        .unwrap();
    let mut moved = book("b1", "Stale name", "0000000000000005-0000-a");
    moved.parent_id = Some("b0".into());
    moved.parent_hlc = "0000000000000020-0000-a".into();
    store.put_book(&moved).unwrap();
    let books = store.list_books().unwrap();
    assert_eq!(books.len(), 1);
    assert_eq!(books[0].name, "Work");
    assert_eq!(books[0].parent_id.as_deref(), Some("b0"));
}

#[test]
fn notebooks_keep_ai_access_off_by_default_and_merge_it_per_field() {
    let (_dir, mut store) = temp_store();
    store
        .put_book(&book("b1", "Work", "0000000000000010-0000-a"))
        .unwrap();
    assert!(!store.list_books().unwrap()[0].ai_access, "off by default");

    let mut on = book("b1", "Work", "0000000000000010-0000-a");
    on.ai_access = true;
    on.ai_access_hlc = "0000000000000030-0000-a".into();
    store.put_book(&on).unwrap();

    // A stale copy: a newer name, but an older AI access switch.
    let mut stale = book("b1", "Job", "0000000000000040-0000-a");
    stale.ai_access = false;
    stale.ai_access_hlc = "0000000000000020-0000-a".into();
    store.put_book(&stale).unwrap();

    let books = store.list_books().unwrap();
    assert_eq!(books[0].name, "Job");
    assert!(books[0].ai_access, "the newer switch wins");
    assert_eq!(books[0].ai_access_hlc, "0000000000000030-0000-a");
}

#[test]
fn notebooks_merge_their_sort_key_per_field() {
    let (_dir, mut store) = temp_store();
    store
        .put_book(&book("b1", "Work", "0000000000000010-0000-a"))
        .unwrap();

    let mut moved = book("b1", "Work", "0000000000000010-0000-a");
    moved.sort_key = "a0V".into();
    moved.sort_key_hlc = "0000000000000030-0000-a".into();
    store.put_book(&moved).unwrap();

    // A stale copy: a newer name, but an older place.
    let mut stale = book("b1", "Job", "0000000000000040-0000-a");
    stale.sort_key = "a5".into();
    stale.sort_key_hlc = "0000000000000020-0000-a".into();
    store.put_book(&stale).unwrap();

    let books = store.list_books().unwrap();
    assert_eq!(books[0].name, "Job");
    assert_eq!(books[0].sort_key, "a0V", "the newer place wins");
    assert_eq!(books[0].sort_key_hlc, "0000000000000030-0000-a");
}

#[test]
fn equal_sort_key_clocks_merge_to_the_greater_key_in_any_order() {
    // Two devices gave the same old notebook different keys (no clock).
    let migrated = |key: &str| {
        let mut b = book("b1", "Work", "0000000000000010-0000-a");
        b.sort_key = key.into();
        b.sort_key_hlc = String::new();
        b
    };
    for order in [["a1", "a3"], ["a3", "a1"]] {
        let (_dir, mut store) = temp_store();
        for key in order {
            store.put_book(&migrated(key)).unwrap();
        }
        assert_eq!(store.list_books().unwrap()[0].sort_key, "a3");
    }
}

#[test]
fn the_book_order_migration_adds_unset_keys_and_keeps_the_rows() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("devot.sqlite");
    let id = |n: u32| format!("0192a6f0-0000-7000-8000-{:012}", 999 - n);
    {
        // A version 9 database with notebooks made before sort keys existed.
        let conn = Connection::open(&path).unwrap();
        for (index, sql) in MIGRATIONS.iter().take(9).enumerate() {
            conn.execute_batch(sql).unwrap();
            conn.pragma_update(None, "user_version", index as u32 + 1)
                .unwrap();
        }
        let mut insert = conn
            .prepare(
                "INSERT INTO books (id, name, name_hlc, parent_id, parent_hlc, created_at,
                                    updated_at, deleted_at, deleted_hlc)
                 VALUES (?1, ?2, 'h', ?3, 'h', 1, 1, NULL, NULL)",
            )
            .unwrap();
        insert
            .execute(params![id(0), "beta", None::<String>])
            .unwrap();
        insert.execute(params![id(1), "Zed", Some(id(0))]).unwrap();
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    let books = store.list_books().unwrap();
    assert_eq!(books.len(), 2);
    let zed = books.iter().find(|b| b.id == id(1)).unwrap();
    assert_eq!(
        (zed.name.as_str(), zed.parent_id.clone()),
        ("Zed", Some(id(0)))
    );
    // The core keys them in the order the sidebar showed (by name in the
    // locale's collation); SQL cannot compare names that way.
    assert!(
        books
            .iter()
            .all(|b| b.sort_key.is_empty() && b.sort_key_hlc.is_empty())
    );
}

#[test]
fn tags_have_no_colour_by_default_and_merge_it_per_field() {
    let (_dir, mut store) = temp_store();
    let tag = |name: &str, name_hlc: &str| TagRecord {
        id: "t".into(),
        name: name.into(),
        name_hlc: name_hlc.into(),
        created_at: 1,
        updated_at: 1,
        deleted_at: None,
        deleted_hlc: None,
        color: None,
        color_hlc: String::new(),
    };
    store
        .put_tag(&tag("idea", "0000000000000010-0000-a"))
        .unwrap();
    assert_eq!(store.list_tags().unwrap()[0].color, None, "none by default");

    let mut red = tag("idea", "0000000000000010-0000-a");
    red.color = Some("red".into());
    red.color_hlc = "0000000000000030-0000-a".into();
    store.put_tag(&red).unwrap();

    // A stale copy: a newer name, but an older colour.
    let mut stale = tag("ideas", "0000000000000040-0000-b");
    stale.color = Some("blue".into());
    stale.color_hlc = "0000000000000020-0000-b".into();
    store.put_tag(&stale).unwrap();
    let tags = store.list_tags().unwrap();
    assert_eq!(tags[0].name, "ideas");
    assert_eq!(
        tags[0].color.as_deref(),
        Some("red"),
        "the newer colour wins"
    );
    assert_eq!(tags[0].color_hlc, "0000000000000030-0000-a");

    // Taking the colour off is a write like any other.
    let mut cleared = tag("ideas", "0000000000000040-0000-b");
    cleared.color_hlc = "0000000000000050-0000-b".into();
    store.put_tag(&cleared).unwrap();
    let tags = store.list_tags().unwrap();
    assert_eq!(tags[0].color, None);
    assert_eq!(tags[0].color_hlc, "0000000000000050-0000-b");
}

#[test]
fn lists_a_tag_colour_it_does_not_know_as_none() {
    // A palette ID from a later Devot (through sync) reads as no colour; its
    // HLC stays, so an older write still cannot replace it.
    let (_dir, mut store) = temp_store();
    store
        .put_tag(&TagRecord {
            id: "t".into(),
            name: "idea".into(),
            name_hlc: "0000000000000001-0000-a".into(),
            created_at: 1,
            updated_at: 1,
            deleted_at: None,
            deleted_hlc: None,
            color: Some("ultraviolet".into()),
            color_hlc: "0000000000000030-0000-a".into(),
        })
        .unwrap();
    let tags = store.list_tags().unwrap();
    assert_eq!(tags[0].color, None);
    assert_eq!(tags[0].color_hlc, "0000000000000030-0000-a");
}

#[test]
fn data_version_moves_only_for_commits_from_other_connections() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("devot.sqlite");
    let mut store = Store::open(&path).unwrap();
    let start = store.data_version().unwrap();

    // The app's own writes do not count as outside changes.
    store.put_note(&note("own", "Own", 10), &[]).unwrap();
    assert_eq!(store.data_version().unwrap(), start);

    // devot-mcp writes through its own connection.
    let other = Connection::open(&path).unwrap();
    other
        .execute(
            "INSERT INTO notes (id, title, title_hlc, body_md, ydoc, created_at, updated_at)
             VALUES ('ext', 'From outside', 'h', '', x'00', 1, 1)",
            [],
        )
        .unwrap();
    let after = store.data_version().unwrap();
    assert_ne!(after, start);
    assert_eq!(
        store.data_version().unwrap(),
        after,
        "stable until the next change"
    );
    assert_eq!(store.list_notes().unwrap().len(), 2);
}

/// How long another writer holds the database in these tests: well within
/// the busy timeout.
const HOLD: Duration = Duration::from_millis(250);

/// Another connection holding the write lock for `hold`, as devot-mcp does
/// while it writes; returns once the lock is held. Joining the thread
/// waits for its commit.
fn another_writer(path: &Path, hold: Duration) -> std::thread::JoinHandle<()> {
    let path = path.to_owned();
    let (held, holding) = std::sync::mpsc::channel();
    let writer = std::thread::spawn(move || {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        held.send(()).unwrap();
        std::thread::sleep(hold);
        conn.execute_batch("COMMIT").unwrap();
    });
    holding.recv().unwrap();
    writer
}

#[test]
fn the_first_note_save_after_launch_waits_out_another_writer() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("devot.sqlite");
    drop(Store::open(&path).unwrap());
    // A launch: a new connection to the database, which has not used the
    // search index yet.
    let mut store = Store::open(&path).unwrap();
    let writer = another_writer(&path, HOLD);
    store
        .put_note(&note("a", "Waited", 10), &[])
        .expect("the save waits for the other writer");
    writer.join().unwrap();
    assert_eq!(store.get_note("a", false).unwrap().unwrap().title, "Waited");
}

#[test]
fn every_write_waits_out_another_writer() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("devot.sqlite");
    let mut store = Store::open(&path).unwrap();
    store.put_note(&note("a", "Source", 10), &[]).unwrap();
    store.put_note(&note("b", "Copy", 11), &[]).unwrap();
    store
        .put_note(&in_trash(note("c", "Gone", 12), 20), &[])
        .unwrap();
    let copies = [FileCopy {
        from: F1.into(),
        to: F2.into(),
    }];
    type Write = Box<dyn Fn(&mut Store) -> Result<()>>;
    let writes: Vec<(&str, Write)> = vec![
        (
            "put_note",
            Box::new(|s| s.put_note(&based_on(1, note("a", "Renamed", 30)), &[])),
        ),
        (
            "put_file",
            Box::new(|s| s.put_file(&attachment(F1, "a")).map(|live| assert!(live))),
        ),
        (
            "copy_files",
            Box::new(move |s| s.copy_files("b", &copies, 40).map(|live| assert!(live))),
        ),
        (
            "put_book",
            Box::new(|s| s.put_book(&book("k", "Inbox", "0000000000000050-0000-a"))),
        ),
        (
            "put_revision",
            Box::new(|s| s.put_revision(&version("r", "a", 60, &[1]))),
        ),
        (
            "delete_revisions",
            Box::new(|s| s.delete_revisions("a", &["r".into()])),
        ),
        (
            "purge_note",
            Box::new(|s| s.purge_note("c", 70, "0000000000000070-0000-a")),
        ),
    ];
    for (name, write) in &writes {
        let writer = another_writer(&path, HOLD);
        if let Err(error) = write(&mut store) {
            panic!("{name} failed while another connection wrote: {error}");
        }
        writer.join().unwrap();
    }
    assert_eq!(owner(&store, F2).as_deref(), Some("b"));
}

#[test]
fn a_deleted_notebook_stays_deleted_against_stale_copies() {
    let (_dir, mut store) = temp_store();
    let live = book("b1", "Gone", "0000000000000010-0000-a");
    store.put_book(&live).unwrap();
    let mut deleted = live.clone();
    deleted.deleted_at = Some(20);
    deleted.deleted_hlc = Some("0000000000000020-0000-a".into());
    store.put_book(&deleted).unwrap();
    store.put_book(&live).unwrap();
    assert!(store.list_books().unwrap().is_empty());
}

#[test]
fn merges_status_and_pinning_per_field() {
    let (_dir, mut store) = temp_store();
    let mut newer = note("a", "A", 10);
    newer.status = "active".into();
    newer.status_hlc = "0000000000000030-0000-a".into();
    newer.pinned = true;
    newer.pinned_hlc = "0000000000000010-0000-a".into();
    store.put_note(&newer, &[]).unwrap();
    let mut other = based_on(1, note("a", "A", 10));
    other.status = "dropped".into();
    other.status_hlc = "0000000000000020-0000-b".into();
    other.pinned = false;
    other.pinned_hlc = "0000000000000040-0000-b".into();
    store.put_note(&other, &[]).unwrap();
    let stored = store.get_note("a", false).unwrap().unwrap();
    assert_eq!((stored.status.as_str(), stored.pinned), ("active", false));
    let listed = &store.list_notes().unwrap()[0];
    assert_eq!((listed.status.as_str(), listed.pinned), ("active", false));
}

#[test]
fn the_schema_refuses_unknown_statuses() {
    let (_dir, mut store) = temp_store();
    let mut bad = note("a", "A", 10);
    bad.status = "urgent".into();
    assert!(store.put_note(&bad, &[]).is_err());
}

#[test]
fn lists_live_tags_on_notes_and_merges_membership() {
    let (_dir, mut store) = temp_store();
    store.put_note(&note("n", "N", 10), &[]).unwrap();
    let tag = |id: &str| TagRecord {
        id: id.into(),
        name: id.into(),
        name_hlc: "0000000000000001-0000-a".into(),
        created_at: 1,
        updated_at: 1,
        deleted_at: None,
        deleted_hlc: None,
        color: None,
        color_hlc: String::new(),
    };
    store.put_tag(&tag("t1")).unwrap();
    store.put_tag(&tag("t2")).unwrap();
    let link = |tag_id: &str, present: bool, hlc: &str| NoteTagRecord {
        note_id: "n".into(),
        tag_id: tag_id.into(),
        present,
        hlc: hlc.into(),
    };
    store
        .put_note_tag(&link("t1", true, "0000000000000010-0000-a"))
        .unwrap();
    store
        .put_note_tag(&link("t2", true, "0000000000000010-0000-a"))
        .unwrap();
    // An older removal loses; a newer one wins.
    store
        .put_note_tag(&link("t1", false, "0000000000000005-0000-b"))
        .unwrap();
    store
        .put_note_tag(&link("t2", false, "0000000000000020-0000-b"))
        .unwrap();
    assert_eq!(
        store.list_notes().unwrap()[0].tag_ids,
        vec!["t1".to_string()]
    );
    // A deleted tag disappears from notes.
    let mut gone = tag("t1");
    gone.deleted_at = Some(30);
    gone.deleted_hlc = Some("0000000000000030-0000-a".into());
    store.put_tag(&gone).unwrap();
    assert!(store.list_notes().unwrap()[0].tag_ids.is_empty());
    assert!(store.list_tags().unwrap().iter().all(|t| t.id != "t1"));
}

#[test]
fn reads_a_membership_row_with_its_clock() {
    let (_dir, mut store) = temp_store();
    store.put_note(&note("n", "N", 10), &[]).unwrap();
    assert_eq!(store.get_note_tag("n", "t1").unwrap(), None);
    let on = NoteTagRecord {
        note_id: "n".into(),
        tag_id: "t1".into(),
        present: true,
        hlc: "0000000000000010-0000-a".into(),
    };
    store.put_note_tag(&on).unwrap();
    assert_eq!(store.get_note_tag("n", "t1").unwrap(), Some(on.clone()));
    // Taken off later: the row says so, with the later clock.
    let off = NoteTagRecord {
        present: false,
        hlc: "0000000000000020-0000-b".into(),
        ..on
    };
    store.put_note_tag(&off).unwrap();
    assert_eq!(store.get_note_tag("n", "t1").unwrap(), Some(off));
    assert_eq!(store.get_note_tag("n", "t2").unwrap(), None);
    assert_eq!(store.get_note_tag("m", "t1").unwrap(), None);
}

#[test]
fn lists_the_trash_and_purges_for_good() {
    let (_dir, mut store) = temp_store();
    let mut a = note("a", "A", 10);
    a.deleted_at = Some(20);
    a.deleted_hlc = Some("0000000000000020-0000-a".into());
    store.put_note(&a, &[]).unwrap();
    store.put_note(&note("b", "B", 10), &[]).unwrap();
    assert_eq!(store.list_trash().unwrap().len(), 1);
    assert!(store.get_note("a", false).unwrap().is_none());
    assert!(store.get_note("a", true).unwrap().is_some());

    store
        .purge_note("a", 30, "0000000000000030-0000-a")
        .unwrap();
    assert!(store.list_trash().unwrap().is_empty());
    assert!(store.get_note("a", true).unwrap().is_none());
    // A stale copy written later never brings it back.
    let mut stale = note("a", "Revived", 40);
    stale.title_hlc = "9999999999999999-0000-z".into();
    store.put_note(&stale, &[]).unwrap();
    assert!(store.get_note("a", true).unwrap().is_none());
    assert_eq!(store.list_notes().unwrap().len(), 1);
}

#[test]
fn searches_titles_and_bodies_in_any_script() {
    let (_dir, mut store) = temp_store();
    let mut a = note("a", "Relay design", 10);
    a.body_md = "WebSocket hibernation".into();
    store.put_note(&a, &[]).unwrap();
    let mut b = note("b", "\u{540c}\u{6b65}\u{65b9}\u{6848}", 20);
    b.body_md = "Yjs".into();
    store.put_note(&b, &[]).unwrap();
    let mut gone = note("c", "Relay trash", 30);
    gone.deleted_at = Some(31);
    gone.deleted_hlc = Some("0000000000000031-0000-a".into());
    store.put_note(&gone, &[]).unwrap();

    let ids = |terms: &[&str]| -> Vec<String> {
        store
            .search_notes(&words(terms), 50)
            .unwrap()
            .into_iter()
            .map(|n| n.id)
            .collect()
    };
    assert_eq!(ids(&["relay"]), ["a"], "trashed notes never match");
    assert_eq!(ids(&["hibernat"]), ["a"]);
    assert_eq!(ids(&["\u{540c}\u{6b65}\u{65b9}"]), ["b"]);
    assert_eq!(
        ids(&["\u{540c}\u{6b65}"]),
        ["b"],
        "two characters are scanned"
    );
    assert_eq!(ids(&["relay", "yjs"]), Vec::<String>::new());
    assert_eq!(ids(&["NEAR(", "\"x"]), Vec::<String>::new());
}

#[test]
fn short_search_terms_ignore_case_in_every_script() {
    let (_dir, mut store) = temp_store();
    let mut a = note("a", "\u{c9}mile and the \u{c9}COLE", 10);
    a.body_md = "\u{dc}nal \u{410}\u{411} \u{c5}ngstr\u{f6}m".into();
    store.put_note(&a, &[]).unwrap();
    let mut b = note("b", "Plain", 20);
    b.body_md = "ascii only".into();
    store.put_note(&b, &[]).unwrap();

    let ids = |query: NoteQuery| -> Vec<String> {
        store
            .search_notes(&query, 50)
            .unwrap()
            .into_iter()
            .map(|n| n.id)
            .collect()
    };
    // Two characters are scanned, three or more use the trigram index: both
    // find a note in any case.
    for term in [
        "\u{e9}m",
        "\u{c9}M",
        "\u{e9}c",
        "\u{c9}c",
        "\u{fc}n",
        "\u{dc}N",
        "\u{430}\u{431}",
        "\u{e5}n",
        "\u{c5}N",
        "\u{e9}mi",
        "\u{c9}MI",
        "\u{e9}cole",
    ] {
        assert_eq!(ids(words(&[term])), ["a"], "{term}");
    }
    assert!(ids(words(&["\u{e9}x"])).is_empty());
    // An accent is not ignored: e is not \u{e9}.
    assert_eq!(ids(words(&["em"])), Vec::<String>::new());
    let field = |field: TextField, term: &str, negate: bool| NoteQuery {
        text: vec![TextCondition {
            field,
            value: term.into(),
            negate,
        }],
        sets: Vec::new(),
        pinned: false,
    };
    assert_eq!(ids(field(TextField::Any, "\u{c9}M", true)), ["b"]);
    assert_eq!(ids(field(TextField::Title, "\u{e9}m", false)), ["a"]);
    assert!(ids(field(TextField::Body, "\u{e9}m", false)).is_empty());
    assert_eq!(ids(field(TextField::Body, "\u{fc}n", false)), ["a"]);
}

#[test]
fn devot_fold_agrees_with_the_shared_cases() {
    #[derive(serde::Deserialize)]
    struct Case {
        why: String,
        text: String,
        folded: String,
    }
    let cases: Vec<Case> =
        serde_json::from_str(include_str!("../../../tests/support/folds.json")).unwrap();
    assert!(cases.len() > 10);
    let (_dir, store) = temp_store();
    for case in cases {
        let folded: String = store
            .conn
            .query_row("SELECT devot_fold(?1)", [&case.text], |row| row.get(0))
            .unwrap();
        assert_eq!(folded, case.folded, "{}", case.why);
        assert_eq!(fold_text(&case.text), case.folded, "{}", case.why);
    }
    let none: Option<String> = store
        .conn
        .query_row("SELECT devot_fold(NULL)", [], |row| row.get(0))
        .unwrap();
    assert_eq!(none, None);
}

#[test]
fn the_search_index_follows_edits_and_purges() {
    let (_dir, mut store) = temp_store();
    let mut a = note("a", "Draft", 10);
    a.body_md = "first words".into();
    store.put_note(&a, &[]).unwrap();
    let mut edited = based_on(1, a.clone());
    edited.body_md = "second words".into();
    edited.updated_at = 20;
    store.put_note(&edited, &[]).unwrap();
    let found = |store: &Store, t: &str| store.search_notes(&words(&[t]), 10).unwrap().len();
    assert_eq!(found(&store, "first"), 0);
    assert_eq!(found(&store, "second"), 1);
    store
        .purge_note("a", 30, "0000000000000030-0000-a")
        .unwrap();
    assert_eq!(found(&store, "second"), 0);
}

/// Notes in Work (w) and its sub-notebook Projects (p, the store sees only
/// IDs), tagged, with statuses; every note mentions "plan".
fn search_world() -> (tempfile::TempDir, Store) {
    let (dir, mut store) = temp_store();
    let mut put = |id: &str, title: &str, body: &str, book: Option<&str>, status: &str| {
        let mut n = note(id, title, 10);
        n.body_md = body.into();
        n.book_id = book.map(String::from);
        n.book_hlc = if book.is_some() {
            "0000000000000002-0000-a".into()
        } else {
            String::new()
        };
        n.status = status.into();
        store.put_note(&n, &[]).unwrap();
    };
    put(
        "relay",
        "Relay plan",
        "hibernation plan for the relay",
        Some("w"),
        "active",
    );
    put(
        "editor",
        "Editor plan",
        "a plan with Yjs and the relay",
        Some("p"),
        "none",
    );
    put(
        "week",
        "Week 41",
        "plan the week; relay later",
        Some("k"),
        "on_hold",
    );
    put(
        "loose",
        "Loose plan",
        "a \u{540c}\u{6b65} plan",
        None,
        "none",
    );
    store
        .put_tag(&TagRecord {
            id: "t".into(),
            name: "sync".into(),
            name_hlc: "0000000000000001-0000-a".into(),
            created_at: 1,
            updated_at: 1,
            deleted_at: None,
            deleted_hlc: None,
            color: None,
            color_hlc: String::new(),
        })
        .unwrap();
    for id in ["relay", "editor"] {
        store
            .put_note_tag(&NoteTagRecord {
                note_id: id.into(),
                tag_id: "t".into(),
                present: true,
                hlc: "0000000000000010-0000-a".into(),
            })
            .unwrap();
    }
    (dir, store)
}

fn text(field: TextField, value: &str, negate: bool) -> TextCondition {
    TextCondition {
        field,
        value: value.into(),
        negate,
    }
}

fn set(kind: SetKind, ids: &[&str], negate: bool) -> SetCondition {
    SetCondition {
        kind,
        ids: ids.iter().map(|s| s.to_string()).collect(),
        negate,
    }
}

fn found(store: &Store, text: Vec<TextCondition>, sets: Vec<SetCondition>) -> Vec<String> {
    let mut ids: Vec<String> = store
        .search_notes(
            &NoteQuery {
                text,
                sets,
                pinned: false,
            },
            50,
        )
        .unwrap()
        .into_iter()
        .map(|n| n.id)
        .collect();
    ids.sort();
    ids
}

#[test]
fn combines_notebook_tag_and_status_conditions_with_full_text_search() {
    let (_dir, store) = search_world();
    let plan = || vec![text(TextField::Any, "plan", false)];
    assert_eq!(
        found(&store, plan(), vec![set(SetKind::Book, &["w", "p"], false)]),
        ["editor", "relay"]
    );
    assert_eq!(
        found(&store, plan(), vec![set(SetKind::Book, &["w", "p"], true)]),
        ["loose", "week"],
        "notes in no notebook are outside every notebook"
    );
    assert_eq!(
        found(&store, plan(), vec![set(SetKind::Tag, &["t"], false)]),
        ["editor", "relay"]
    );
    assert_eq!(
        found(&store, plan(), vec![set(SetKind::Tag, &["t"], true)]),
        ["loose", "week"]
    );
    assert_eq!(
        found(&store, plan(), vec![set(SetKind::Status, &["none"], true)]),
        ["relay", "week"]
    );
    assert_eq!(
        found(
            &store,
            vec![],
            vec![set(SetKind::Status, &["active", "on_hold"], false)]
        ),
        ["relay", "week"],
        "conditions alone are a query"
    );
    assert_eq!(
        found(
            &store,
            vec![
                text(TextField::Body, "plan with", false),
                text(TextField::Title, "relay", true),
            ],
            vec![
                set(SetKind::Book, &["w", "p"], false),
                set(SetKind::Tag, &["t"], false),
                set(SetKind::Status, &["active"], true),
            ]
        ),
        ["editor"]
    );
}

#[test]
fn searches_titles_or_bodies_only_and_excludes_text() {
    let (_dir, store) = search_world();
    assert_eq!(
        found(&store, vec![text(TextField::Title, "relay", false)], vec![]),
        ["relay"]
    );
    assert_eq!(
        found(&store, vec![text(TextField::Body, "relay", false)], vec![]),
        ["editor", "relay", "week"]
    );
    assert_eq!(
        found(
            &store,
            vec![
                text(TextField::Any, "relay", false),
                text(TextField::Title, "relay", true)
            ],
            vec![]
        ),
        ["editor", "week"]
    );
    assert_eq!(
        found(&store, vec![text(TextField::Any, "relay", true)], vec![]),
        ["loose"]
    );
    // Short text is scanned in every position too.
    assert_eq!(
        found(&store, vec![text(TextField::Title, "41", false)], vec![]),
        ["week"]
    );
    assert_eq!(
        found(
            &store,
            vec![
                text(TextField::Any, "plan", false),
                text(TextField::Body, "\u{540c}\u{6b65}", true)
            ],
            vec![]
        ),
        ["editor", "relay", "week"]
    );
    // FTS syntax is plain text.
    assert!(found(&store, vec![text(TextField::Title, "NEAR(", false)], vec![]).is_empty());
}

#[test]
fn keeps_only_pinned_notes_when_asked() {
    let (_dir, mut store) = search_world();
    let mut pinned = store.get_note("week", false).unwrap().unwrap();
    pinned.pinned = true;
    pinned.pinned_hlc = "0000000000000020-0000-a".into();
    store.put_note(&pinned, &[]).unwrap();
    let query = NoteQuery {
        text: vec![text(TextField::Any, "plan", false)],
        sets: vec![],
        pinned: true,
    };
    let ids: Vec<String> = store
        .search_notes(&query, 50)
        .unwrap()
        .into_iter()
        .map(|n| n.id)
        .collect();
    assert_eq!(ids, ["week"]);
}

#[test]
fn applies_every_condition_before_the_limit() {
    let (_dir, mut store) = search_world();
    for i in 0..60 {
        let mut n = note(&format!("filler{i}"), "Filler", 1_000 + i);
        n.body_md = "plan plan plan".into();
        store.put_note(&n, &[]).unwrap();
    }
    let query = |sets| NoteQuery {
        text: vec![text(TextField::Any, "plan", false)],
        sets,
        pinned: false,
    };
    assert_eq!(store.search_notes(&query(vec![]), 50).unwrap().len(), 50);
    let mut ids: Vec<String> = store
        .search_notes(&query(vec![set(SetKind::Book, &["w", "p"], false)]), 50)
        .unwrap()
        .into_iter()
        .map(|n| n.id)
        .collect();
    ids.sort();
    assert_eq!(ids, ["editor", "relay"]);
}

#[test]
fn returns_the_body_around_the_first_searched_word_found() {
    let (_dir, mut store) = temp_store();
    let mut long = note("long", "Long", 10);
    long.body_md = format!(
        "{}the hibernation plan{}",
        "lorem ipsum ".repeat(20),
        " dolor".repeat(40)
    );
    store.put_note(&long, &[]).unwrap();
    let mut short = note("short", "Short", 20);
    short.body_md = "one\nRelay here".into();
    store.put_note(&short, &[]).unwrap();
    let mut german = note("german", "German", 30);
    german.body_md = "Kein \u{c4}rger im Team".into();
    store.put_note(&german, &[]).unwrap();
    let excerpt = |query: NoteQuery| store.search_notes(&query, 10).unwrap()[0].excerpt.clone();

    let found = excerpt(words(&["hibernation"])).unwrap();
    assert!(
        found.starts_with('\u{2026}'),
        "a cut start shows an ellipsis"
    );
    assert!(found.contains("ipsum the hibernation plan dolor"));
    assert_eq!(found.chars().count(), 161);
    assert_eq!(
        excerpt(words(&["relay"])).as_deref(),
        Some("one Relay here")
    );
    // Case folds beyond ASCII, as the index does.
    assert_eq!(
        excerpt(words(&["\u{e4}RGER"])).as_deref(),
        Some("Kein \u{c4}rger im Team")
    );
    assert_eq!(
        excerpt(NoteQuery {
            text: vec![text(TextField::Title, "short", false)],
            sets: vec![],
            pinned: false,
        }),
        None,
        "a title search shows no excerpt"
    );
    // Listing never carries one.
    assert!(
        store
            .list_notes()
            .unwrap()
            .iter()
            .all(|n| n.excerpt.is_none())
    );
}

#[test]
fn a_write_rewrites_the_search_index_only_when_title_or_markdown_changes() {
    let (_dir, mut store) = temp_store();
    let mut plan = note("plan", "Launch plan", 1);
    plan.body_md = "The relay goes first.".into();
    store.put_note(&plan, &[]).unwrap();
    // Rows changed by a write, the index's own tables included.
    let cost = |store: &mut Store, record: &NoteRecord| {
        let before = store.conn.total_changes();
        store.put_note(record, &[]).unwrap();
        store.conn.total_changes() - before
    };
    let mut pinned = based_on(1, plan.clone());
    pinned.pinned = true;
    pinned.pinned_hlc = "0000000000002-0000-test".into();
    pinned.updated_at = 2;
    assert_eq!(cost(&mut store, &pinned), 1, "a pin writes the row alone");
    let mut trashed = based_on(2, pinned.clone());
    trashed.deleted_at = Some(3);
    trashed.deleted_hlc = Some("0000000000003-0000-test".into());
    assert_eq!(cost(&mut store, &trashed), 1, "so does the Trash");
    let mut restored = based_on(3, trashed.clone());
    restored.deleted_at = None;
    restored.deleted_hlc = Some("0000000000004-0000-test".into());
    assert_eq!(cost(&mut store, &restored), 1, "and a restore");
    let found = |store: &Store, t: &str| store.search_notes(&words(&[t]), 10).unwrap().len();
    assert_eq!((found(&store, "relay"), found(&store, "launch")), (1, 1));

    let mut renamed = based_on(4, restored.clone());
    renamed.title = "Launch day".into();
    renamed.title_hlc = "0000000000005-0000-test".into();
    assert!(cost(&mut store, &renamed) > 1, "a new title is indexed");
    assert_eq!((found(&store, "plan"), found(&store, "day")), (0, 1));
    let mut edited = based_on(5, renamed.clone());
    edited.body_md = "Snapshot first.".into();
    assert!(cost(&mut store, &edited) > 1, "a new body is indexed");
    assert_eq!((found(&store, "relay"), found(&store, "snapshot")), (0, 1));
    // The index agrees with the table: nothing stale is left in it.
    store
        .conn
        .execute_batch("INSERT INTO notes_fts (notes_fts, rank) VALUES ('integrity-check', 1)")
        .unwrap();
}

#[test]
fn lists_and_searches_read_covering_indexes() {
    let (_dir, store) = temp_store();
    let plan = |sql: &str, values: &[String]| -> String {
        let mut statement = store
            .conn
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
            .unwrap();
        let rows = statement
            .query_map(rusqlite::params_from_iter(values.iter()), |row| {
                row.get::<_, String>(3)
            })
            .unwrap();
        rows.map(|r| r.unwrap()).collect::<Vec<_>>().join("\n")
    };
    assert!(plan(NOTES_LIST_SQL, &[]).starts_with("SCAN notes USING COVERING INDEX notes_list"));
    assert!(plan(TRASH_LIST_SQL, &[]).starts_with("SEARCH notes USING COVERING INDEX notes_trash"));
    // Ranked text: its matches first, joined to the list's index.
    let (sql, values) = search_sql(&words(&["snapshot"]), 200);
    let ranked = plan(&sql, &values);
    assert!(ranked.contains("MATERIALIZE hits"), "{ranked}");
    assert!(
        ranked.contains("SCAN n USING COVERING INDEX notes_list"),
        "{ranked}"
    );
    assert!(
        ranked.contains("AUTOMATIC COVERING INDEX (rid=?)"),
        "{ranked}"
    );
    assert!(!ranked.contains("INTEGER PRIMARY KEY"), "{ranked}");
    // Qualifiers alone: the index's order, so a page stops early.
    let qualifiers = NoteQuery {
        text: vec![],
        sets: vec![set(SetKind::Status, &["active"], false)],
        pinned: true,
    };
    let (sql, values) = search_sql(&qualifiers, 200);
    let sets = plan(&sql, &values);
    assert!(
        sets.starts_with("SCAN n USING COVERING INDEX notes_list"),
        "{sets}"
    );
    assert!(!sets.contains("TEMP B-TREE"), "{sets}");
}

#[test]
fn search_orders_notes_saved_at_the_same_moment_by_id_as_the_list() {
    let (_dir, mut store) = temp_store();
    for id in ["a", "c", "b"] {
        let mut same = note(id, &format!("note {id}"), 5);
        same.body_md = "same words".into();
        store.put_note(&same, &[]).unwrap();
    }
    let ids = |found: Vec<NoteSummary>| found.into_iter().map(|n| n.id).collect::<Vec<_>>();
    assert_eq!(ids(store.list_notes().unwrap()), ["c", "b", "a"]);
    assert_eq!(
        ids(store.search_notes(&words(&["same"]), 10).unwrap()),
        ["c", "b", "a"]
    );
    let none = NoteQuery {
        text: vec![],
        sets: vec![],
        pinned: false,
    };
    assert_eq!(ids(store.search_notes(&none, 2).unwrap()), ["c", "b"]);
}

#[test]
fn excerpts_of_long_bodies_agree_with_the_shared_cases() {
    #[derive(serde::Deserialize)]
    struct Case {
        name: String,
        parts: Vec<(String, usize)>,
        terms: Vec<String>,
        excerpt: Option<String>,
    }
    let cases: Vec<Case> =
        serde_json::from_str(include_str!("../../../tests/support/excerpts.json")).unwrap();
    assert!(cases.len() > 10);
    for case in cases {
        let body: String = case.parts.iter().map(|(t, n)| t.repeat(*n)).collect();
        let terms: Vec<&str> = case.terms.iter().map(String::as_str).collect();
        assert_eq!(body_excerpt(&body, &terms), case.excerpt, "{}", case.name);
    }
}

#[test]
fn excerpts_read_only_a_stretch_of_a_long_body() {
    let line = "lorem ipsum **dolor** sit [amet](https://devot.app/amet) consectetur\n";
    let body = format!(
        "{}\nthe needle here\n\n{}",
        line.repeat(800),
        line.repeat(800)
    );
    let found = body_excerpt(&body, &["needle"]).unwrap();
    assert!(found.contains("amet consectetur the needle here lorem"));
    // A page of results (200 excerpts) of 110 KB bodies: reading each body
    // whole took about 70 ms in a release build. Debug builds are slower and
    // the machine may be busy, so this checks against reading the body
    // whole, the best of a few rounds taken in turn: an excerpt (one found,
    // one not) reads a small part of it.
    let time = |work: &dyn Fn()| {
        let start = Instant::now();
        work();
        start.elapsed()
    };
    let (mut excerpts, mut whole) = (Duration::MAX, Duration::MAX);
    for _ in 0..5 {
        excerpts = excerpts.min(time(&|| {
            body_excerpt(&body, &["needle"]);
            body_excerpt(&body, &["absent"]);
        }));
        whole = whole.min(time(&|| {
            readable::readable_text(&body);
        }));
    }
    assert!(
        excerpts * 4 < whole,
        "two excerpts cost {excerpts:?}, against {whole:?} to read the body"
    );
}

#[test]
fn excerpts_skip_front_matter_and_markdown_markers() {
    let (_dir, mut store) = temp_store();
    let mut plan = note("plan", "Launch", 10);
    plan.body_md = "---\ntitle: Launch plan\ntags: [work, q4]\n---\n\
        ![Board](board.png)\n# Inbox\nSee [[Plan]] and the **launch** list"
        .into();
    store.put_note(&plan, &[]).unwrap();
    let excerpt = |terms: &[&str]| {
        store.search_notes(&words(terms), 10).unwrap()[0]
            .excerpt
            .clone()
    };
    assert_eq!(
        excerpt(&["launch"]).as_deref(),
        Some("Board Inbox See Plan and the launch list")
    );
    // A word only the front matter holds finds the note but shows no excerpt.
    assert_eq!(excerpt(&["work"]), None);
}

#[test]
fn stores_attachments_for_live_notes_and_purges_them_with_the_note() {
    let (_dir, mut store) = temp_store();
    store.put_note(&note("n", "Note", 10), &[]).unwrap();
    let file = |id: &str, note_id: &str| FileRecord {
        id: id.into(),
        note_id: note_id.into(),
        name: "a.png".into(),
        mime: "image/png".into(),
        data: vec![1, 2, 3],
        created_at: 1,
    };
    assert!(store.put_file(&file("f1", "n")).unwrap());
    assert!(
        !store.put_file(&file("f2", "missing")).unwrap(),
        "no note, no file"
    );
    assert_eq!(store.get_file("f1").unwrap().unwrap().data, vec![1, 2, 3]);
    assert!(store.get_file("f2").unwrap().is_none());

    // Trashed: the attachment stays. Purged: it goes.
    let mut trashed = based_on(1, note("n", "Note", 10));
    trashed.deleted_at = Some(20);
    trashed.deleted_hlc = Some("0000000000000020-0000-a".into());
    store.put_note(&trashed, &[]).unwrap();
    assert!(store.get_file("f1").unwrap().is_some());
    store
        .purge_note("n", 30, "0000000000000030-0000-a")
        .unwrap();
    assert!(store.get_file("f1").unwrap().is_none());
}

#[test]
fn reads_bodies_of_live_notes_and_names_of_attachments_for_the_mirror() {
    let (_dir, mut store) = temp_store();
    store.put_note(&note("a", "Alive", 10), &[]).unwrap();
    store.put_note(&note("b", "Trashed", 10), &[]).unwrap();
    store.put_note(&note("c", "Purged", 10), &[]).unwrap();
    let mut trashed = based_on(1, note("b", "Trashed", 10));
    trashed.deleted_at = Some(20);
    trashed.deleted_hlc = Some("0000000000000020-0000-a".into());
    store.put_note(&trashed, &[]).unwrap();
    let mut purged = based_on(1, note("c", "Purged", 10));
    purged.deleted_at = Some(20);
    purged.deleted_hlc = Some("0000000000000020-0000-a".into());
    store.put_note(&purged, &[]).unwrap();
    store
        .purge_note("c", 30, "0000000000000030-0000-a")
        .unwrap();
    let ids = ["a", "b", "c", "missing"].map(String::from);
    assert_eq!(
        store.note_bodies(&ids).unwrap(),
        vec![("a".to_string(), "# Alive\n".to_string())]
    );
    assert!(store.note_bodies(&[]).unwrap().is_empty());

    store
        .put_file(&FileRecord {
            id: "f1".into(),
            note_id: "a".into(),
            name: "board.png".into(),
            mime: "image/png".into(),
            data: vec![1, 2, 3],
            created_at: 1,
        })
        .unwrap();
    assert_eq!(
        store.file_names(&["f1".into(), "f2".into()]).unwrap(),
        vec![(
            "f1".to_string(),
            "board.png".to_string(),
            "image/png".to_string()
        )]
    );
}

#[test]
fn copies_attachments_to_a_live_note_and_keeps_them_when_the_source_is_purged() {
    let (_dir, mut store) = temp_store();
    store.put_note(&note("a", "Source", 10), &[]).unwrap();
    store.put_note(&note("b", "Extracted", 11), &[]).unwrap();
    let original = FileRecord {
        id: "f1".into(),
        note_id: "a".into(),
        name: "shot.png".into(),
        mime: "image/png".into(),
        data: vec![1, 2, 3],
        created_at: 1,
    };
    assert!(store.put_file(&original).unwrap());
    let copy = |from: &str, to: &str| FileCopy {
        from: from.into(),
        to: to.into(),
    };
    assert!(
        store
            .copy_files("b", &[copy("f1", "f2"), copy("gone", "f3")], 50)
            .unwrap()
    );
    assert_eq!(
        store.get_file("f2").unwrap(),
        Some(FileRecord {
            id: "f2".into(),
            note_id: "b".into(),
            created_at: 50,
            ..original.clone()
        })
    );
    assert!(store.get_file("f3").unwrap().is_none(), "nothing to copy");
    assert!(
        !store
            .copy_files("missing", &[copy("f1", "f4")], 50)
            .unwrap(),
        "no note, no copy"
    );
    assert!(store.get_file("f4").unwrap().is_none());

    store
        .purge_note("a", 60, "0000000000000060-0000-a")
        .unwrap();
    assert!(store.get_file("f1").unwrap().is_none());
    assert_eq!(store.get_file("f2").unwrap().unwrap().data, vec![1, 2, 3]);

    // A trashed note takes no copies.
    let mut trashed = based_on(1, note("b", "Extracted", 11));
    trashed.deleted_at = Some(70);
    trashed.deleted_hlc = Some("0000000000000070-0000-a".into());
    store.put_note(&trashed, &[]).unwrap();
    assert!(!store.copy_files("b", &[copy("f2", "f5")], 80).unwrap());
    assert!(store.get_file("f5").unwrap().is_none());
}

/// A note whose Markdown is `body`.
fn note_showing(id: &str, body: &str) -> NoteRecord {
    NoteRecord {
        body_md: body.into(),
        ..note(id, id, 10)
    }
}

fn in_trash(mut record: NoteRecord, at: i64) -> NoteRecord {
    record.deleted_at = Some(at);
    record.deleted_hlc = Some(format!("{at:016}-0000-a"));
    record
}

fn attachment(id: &str, note_id: &str) -> FileRecord {
    FileRecord {
        id: id.into(),
        note_id: note_id.into(),
        name: "shot.png".into(),
        mime: "image/png".into(),
        data: vec![1, 2, 3],
        created_at: 1,
    }
}

/// The note an attachment belongs to; None once it is deleted.
fn owner(store: &Store, file: &str) -> Option<String> {
    store.get_file(file).unwrap().map(|f| f.note_id)
}

const F1: &str = "0192a6f0-0000-7000-8000-00000000f001";
const F2: &str = "0192a6f0-0000-7000-8000-00000000f002";
const F3: &str = "0192a6f0-0000-7000-8000-00000000f003";
const F4: &str = "0192a6f0-0000-7000-8000-00000000f004";

#[test]
fn purging_a_note_keeps_the_attachments_other_notes_still_show() {
    let (_dir, mut store) = temp_store();
    let shows = |ids: &[&str]| -> String {
        ids.iter()
            .map(|id| format!("![shot](devot://file/{id})\n"))
            .collect()
    };
    store
        .put_note(&note_showing("a", &shows(&[F1, F2, F3, F4])), &[])
        .unwrap();
    for id in [F1, F2, F3, F4] {
        assert!(store.put_file(&attachment(id, "a")).unwrap());
    }
    // Links that reached other notes without a copy (pasted, dragged, an
    // old duplicate): b is in the Trash, c and d are live.
    store
        .put_note(&in_trash(note_showing("b", &shows(&[F1, F2])), 20), &[])
        .unwrap();
    let pasted = format!("Pasted at a size ![](devot://file/{F1}#half) and bare devot://file/{F1}");
    store.put_note(&note_showing("d", &pasted), &[]).unwrap();
    store
        .put_note(&note_showing("c", &shows(&[F1])), &[])
        .unwrap();
    // Mentions that are not the address as written keep nothing: in
    // capitals, cut short, the ID alone, only in a title.
    let near = format!(
        "DEVOT://FILE/{} devot://file/{} {F4}",
        F3.to_uppercase(),
        &F3[..30]
    );
    store.put_note(&note_showing("e", &near), &[]).unwrap();
    let mut titled = note_showing("f", "No images");
    titled.title = format!("devot://file/{F4}");
    store.put_note(&titled, &[]).unwrap();

    store
        .purge_note("a", 30, "0000000000000030-0000-a")
        .unwrap();
    // A live note first (c, before d), else one in the Trash; nothing shows F3 or F4.
    assert_eq!(owner(&store, F1).as_deref(), Some("c"));
    assert_eq!(owner(&store, F2).as_deref(), Some("b"));
    assert_eq!(owner(&store, F3), None);
    assert_eq!(owner(&store, F4), None);
    assert_eq!(store.get_file(F1).unwrap().unwrap().data, vec![1, 2, 3]);

    // Emptying the Trash: nothing left shows F2.
    store
        .purge_note("b", 40, "0000000000000040-0000-a")
        .unwrap();
    assert_eq!(owner(&store, F2), None);
    assert_eq!(owner(&store, F1).as_deref(), Some("c"));
    // F1 passes on again, then goes with the last note that shows it.
    store
        .purge_note("c", 50, "0000000000000050-0000-a")
        .unwrap();
    assert_eq!(owner(&store, F1).as_deref(), Some("d"));
    store
        .purge_note("d", 60, "0000000000000060-0000-a")
        .unwrap();
    assert_eq!(owner(&store, F1), None);
}

#[test]
fn an_attachment_no_other_note_shows_any_more_goes_with_its_note() {
    let (_dir, mut store) = temp_store();
    store
        .put_note(&note_showing("a", &format!("![](devot://file/{F1})")), &[])
        .unwrap();
    assert!(store.put_file(&attachment(F1, "a")).unwrap());
    store
        .put_note(&note_showing("b", &format!("![](devot://file/{F1})")), &[])
        .unwrap();
    // b's link is edited away before the purge: only its latest body counts.
    store
        .put_note(
            &based_on(1, note_showing("b", "The image was removed")),
            &[],
        )
        .unwrap();
    store
        .purge_note("a", 30, "0000000000000030-0000-a")
        .unwrap();
    assert_eq!(owner(&store, F1), None);
}

fn link_rows(store: &Store) -> Vec<(String, String)> {
    let mut stmt = store
        .conn
        .prepare("SELECT source_id, target_id FROM links ORDER BY source_id, target_id")
        .unwrap();
    stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

#[test]
fn keeps_each_notes_link_rows_with_its_latest_body() {
    let (_dir, mut store) = temp_store();
    let pair = |s: &str, t: &str| (s.to_string(), t.to_string());
    store
        .put_note(&note("a", "A", 10), &["b".into(), "c".into()])
        .unwrap();
    store.put_note(&note("b", "B", 10), &["a".into()]).unwrap();
    assert_eq!(
        link_rows(&store),
        [pair("a", "b"), pair("a", "c"), pair("b", "a")]
    );
    // A new body replaces the rows; trashing keeps them; purging drops them.
    store
        .put_note(&based_on(1, note("a", "A", 11)), &["d".into()])
        .unwrap();
    let mut trashed = based_on(1, note("b", "B", 12));
    trashed.deleted_at = Some(12);
    trashed.deleted_hlc = Some("0000000000000012-0000-a".into());
    store.put_note(&trashed, &["a".into()]).unwrap();
    assert_eq!(link_rows(&store), [pair("a", "d"), pair("b", "a")]);
    store
        .purge_note("b", 13, "0000000000000013-0000-a")
        .unwrap();
    assert_eq!(link_rows(&store), [pair("a", "d")]);
    // A write to a purged note changes nothing.
    store.put_note(&note("b", "B", 14), &["a".into()]).unwrap();
    assert_eq!(link_rows(&store), [pair("a", "d")]);
}

#[test]
fn the_link_migration_indexes_existing_bodies_like_the_core() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("devot.sqlite");
    let a = "0192a6f0-0000-7000-8000-00000000000a";
    let b = "0192a6f0-0000-7000-8000-00000000000b";
    {
        // A version 6 database with bodies written before the index existed.
        let conn = Connection::open(&path).unwrap();
        for (index, sql) in MIGRATIONS.iter().take(6).enumerate() {
            conn.execute_batch(sql).unwrap();
            conn.pragma_update(None, "user_version", index as u32 + 1)
                .unwrap();
        }
        let body = format!(
            "[x](devot://note/{b}) [y](devot://note/{a}) devot://note/{b}\n\
             ![](devot://file/{a}) devot://note/{}  devot://note/{a}0 devot://note/{}",
            a.to_uppercase(),
            &a[..30]
        );
        conn.execute(
            "INSERT INTO notes (id, title, title_hlc, body_md, ydoc, created_at, updated_at)
             VALUES ('src', '', '', ?1, x'', 1, 1)",
            [body],
        )
        .unwrap();
    }
    let store = Store::open(&path).unwrap();
    let pair = |t: &str| ("src".to_string(), t.to_string());
    // Same as noteLinks in src/core/links.ts: a and b once each, nothing else.
    assert_eq!(link_rows(&store), [pair(a), pair(b)]);
}

/// Everything a restore must bring back, read through the public API.
#[derive(Debug, PartialEq)]
struct Contents {
    notes: Vec<NoteSummary>,
    records: Vec<Option<NoteRecord>>,
    trash: Vec<TrashedNote>,
    books: Vec<BookRecord>,
    tags: Vec<TagRecord>,
    file: Option<FileRecord>,
    found: Vec<NoteSummary>,
}

fn contents(store: &Store) -> Contents {
    let ids = ["a", "b", "c", "late"];
    Contents {
        notes: store.list_notes().unwrap(),
        records: ids
            .iter()
            .flat_map(|id| {
                [
                    store.get_note(id, false).unwrap(),
                    store.get_note(id, true).unwrap(),
                ]
            })
            .collect(),
        trash: store.list_trash().unwrap(),
        books: store.list_books().unwrap(),
        tags: store.list_tags().unwrap(),
        file: store.get_file("f1").unwrap(),
        found: store.search_notes(&words(&["Groceries"]), 50).unwrap(),
    }
}

fn filled_store() -> (tempfile::TempDir, Store) {
    let (dir, mut store) = temp_store();
    store
        .put_book(&book("bk", "Home", "0000000000000001-0000-a"))
        .unwrap();
    let mut a = note("a", "Groceries", 10);
    a.book_id = Some("bk".into());
    a.pinned = true;
    store.put_note(&a, &[]).unwrap();
    store.put_note(&note("b", "Ideas", 11), &[]).unwrap();
    let mut c = note("c", "Old", 12);
    c.deleted_at = Some(13);
    c.deleted_hlc = Some("0000000000000013-0000-a".into());
    store.put_note(&c, &[]).unwrap();
    store
        .put_tag(&TagRecord {
            id: "t".into(),
            name: "home".into(),
            name_hlc: "0000000000000001-0000-a".into(),
            created_at: 1,
            updated_at: 1,
            deleted_at: None,
            deleted_hlc: None,
            color: None,
            color_hlc: String::new(),
        })
        .unwrap();
    store
        .put_note_tag(&NoteTagRecord {
            note_id: "a".into(),
            tag_id: "t".into(),
            present: true,
            hlc: "0000000000000010-0000-a".into(),
        })
        .unwrap();
    store
        .put_file(&FileRecord {
            id: "f1".into(),
            note_id: "a".into(),
            name: "a.png".into(),
            mime: "image/png".into(),
            data: vec![9; 70_000],
            created_at: 1,
        })
        .unwrap();
    (dir, store)
}

#[test]
fn restoring_a_snapshot_brings_back_every_record() {
    let (dir, mut store) = filled_store();
    let before = contents(&store);
    let snapshot = dir.path().join("snapshot.sqlite");
    // Taken from a second connection while the store stays open.
    super::snapshot(&dir.path().join("devot.sqlite"), &snapshot).unwrap();

    // Change everything after the snapshot.
    store
        .put_note(&note("late", "Groceries later", 20), &[])
        .unwrap();
    store
        .put_note(&based_on(1, note("b", "Ideas renamed", 21)), &[])
        .unwrap();
    store
        .purge_note("a", 22, "0000000000000022-0000-a")
        .unwrap();
    store
        .purge_note("c", 22, "0000000000000022-0000-a")
        .unwrap();
    store
        .put_book(&book("bk", "Work", "0000000000000023-0000-a"))
        .unwrap();
    assert_ne!(contents(&store), before);

    store.restore_from(&snapshot).unwrap();
    assert_eq!(contents(&store), before);
    // A snapshot is one self-contained file: reading it leaves nothing beside it.
    for side in ["snapshot.sqlite-wal", "snapshot.sqlite-shm"] {
        assert!(!dir.path().join(side).exists(), "{side}");
    }
    assert!(store.integrity_ok().unwrap());
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    // The restored database keeps working.
    store
        .put_note(&note("late", "After restore", 30), &[])
        .unwrap();
    assert_eq!(store.list_notes().unwrap()[0].title, "After restore");
}

#[test]
fn a_restore_refuses_a_snapshot_from_a_newer_devot() {
    let (dir, mut store) = filled_store();
    let snapshot = dir.path().join("snapshot.sqlite");
    super::snapshot(&dir.path().join("devot.sqlite"), &snapshot).unwrap();
    Connection::open(&snapshot)
        .unwrap()
        .pragma_update(None, "user_version", SCHEMA_VERSION + 1)
        .unwrap();
    let before = contents(&store);
    assert!(matches!(
        store.restore_from(&snapshot),
        Err(StorageError::NewerSchema(_))
    ));
    assert_eq!(contents(&store), before);
}

#[test]
fn a_snapshot_of_a_missing_database_fails() {
    let dir = tempfile::tempdir().unwrap();
    assert!(
        super::snapshot(
            &dir.path().join("none.sqlite"),
            &dir.path().join("s.sqlite")
        )
        .is_err()
    );
    assert!(!dir.path().join("s.sqlite").exists());
}

/// Child half of the crash-safety test: writes notes until killed and
/// reports each one only after its transaction committed.
#[test]
#[ignore = "run by crash_safety_keeps_every_committed_note"]
fn crash_child_writer() {
    let Ok(path) = std::env::var("DEVOT_CRASH_DB") else {
        return;
    };
    let mut store = Store::open(Path::new(&path)).unwrap();
    let mut out = std::io::stdout().lock();
    for i in 0..1_000_000_i64 {
        let id = format!("note-{i:07}");
        let mut record = note(&id, "Crash", i);
        record.ydoc = vec![7; 4096];
        store.put_note(&record, &[]).unwrap();
        writeln!(out, "committed {id}").unwrap();
        out.flush().unwrap();
    }
}

#[test]
fn crash_safety_keeps_every_committed_note() {
    let exe = std::env::current_exe().unwrap();
    // Deterministic but varied kill points across rounds.
    for (round, kill_after_ms) in [37_u64, 113, 251, 409].into_iter().enumerate() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devot.sqlite");
        let mut child = Command::new(&exe)
            .args([
                "--exact",
                "storage::tests::crash_child_writer",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("DEVOT_CRASH_DB", &path)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (first_tx, first_rx) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut committed = Vec::new();
            for line in BufReader::new(stdout)
                .lines()
                .map_while(std::result::Result::ok)
            {
                if let Some(id) = line.strip_prefix("committed ") {
                    if committed.is_empty() {
                        let _ = first_tx.send(());
                    }
                    committed.push(id.to_owned());
                }
            }
            committed
        });

        // Start the clock at the first commit, so slow machines (CI) still
        // kill the writer mid-stream rather than before it starts.
        first_rx
            .recv_timeout(Duration::from_secs(30))
            .expect("the child never committed a note");
        let started = Instant::now();
        while started.elapsed() < Duration::from_millis(kill_after_ms) {
            std::thread::sleep(Duration::from_millis(5));
        }
        child.kill().unwrap();
        child.wait().unwrap();
        let committed = reader.join().unwrap();
        assert!(
            !committed.is_empty(),
            "round {round}: the child wrote nothing"
        );

        let store = Store::open(&path).unwrap();
        assert!(
            store.integrity_ok().unwrap(),
            "round {round}: integrity check failed"
        );
        for id in &committed {
            assert!(
                store.get_note(id, false).unwrap().is_some(),
                "round {round}: committed note {id} is missing"
            );
        }
    }
}

#[test]
fn keeps_revisions_per_note_newest_first() {
    let (_dir, mut store) = temp_store();
    store.put_note(&note("a", "A", 10), &[]).unwrap();
    store.put_note(&note("b", "B", 10), &[]).unwrap();
    store
        .put_revision(&version("r1", "a", 100, &[1, 2]))
        .unwrap();
    store
        .put_revision(&event("r2", "a", "title", 200, Some("A")))
        .unwrap();
    store.put_revision(&version("r3", "b", 300, &[3])).unwrap();
    store
        .put_revision(&event("r4", "a", "book", 200, None))
        .unwrap();

    let listed = store.list_revisions("a").unwrap();
    let ids: Vec<&str> = listed.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, ["r4", "r2", "r1"]);
    assert_eq!(listed[2].length, Some(2));
    assert_eq!(
        store.get_revision("r1").unwrap(),
        Some(version("r1", "a", 100, &[1, 2]))
    );
    assert_eq!(store.get_revision("missing").unwrap(), None);
}

#[test]
fn updates_a_revision_only_for_its_own_note_and_kind() {
    let (_dir, mut store) = temp_store();
    store.put_note(&note("a", "A", 10), &[]).unwrap();
    store.put_note(&note("b", "B", 10), &[]).unwrap();
    store
        .put_revision(&event("t", "a", "title", 100, Some("Dra")))
        .unwrap();
    store
        .put_revision(&event("t", "a", "title", 150, Some("Draft")))
        .unwrap();
    assert_eq!(
        store.get_revision("t").unwrap(),
        Some(event("t", "a", "title", 150, Some("Draft")))
    );
    // The same ID from another note or kind changes nothing.
    store
        .put_revision(&event("t", "b", "title", 160, Some("Other")))
        .unwrap();
    store
        .put_revision(&event("t", "a", "status", 170, Some("active")))
        .unwrap();
    assert_eq!(
        store.get_revision("t").unwrap(),
        Some(event("t", "a", "title", 150, Some("Draft")))
    );
}

#[test]
fn compaction_deletes_only_the_named_revisions_of_the_note() {
    let (_dir, mut store) = temp_store();
    store.put_note(&note("a", "A", 10), &[]).unwrap();
    store.put_note(&note("b", "B", 10), &[]).unwrap();
    for (id, note_id) in [("r1", "a"), ("r2", "a"), ("r3", "b")] {
        store.put_revision(&version(id, note_id, 1, &[1])).unwrap();
    }
    store
        .delete_revisions("a", &["r1".into(), "r3".into()])
        .unwrap();
    assert_eq!(store.list_revisions("a").unwrap().len(), 1);
    assert_eq!(store.list_revisions("b").unwrap().len(), 1);
}

/// a: two versions, one taken in 200..300; b: one version before 300, one
/// after; c: two versions, both before 200; d: one version and an event; e:
/// one version beside a baseline, which compaction keeps.
fn compaction_world() -> (tempfile::TempDir, Store) {
    let (dir, mut store) = temp_store();
    for id in ["a", "b", "c", "d", "e"] {
        store.put_note(&note(id, id, 10), &[]).unwrap();
    }
    for (id, note_id, at) in [
        ("r1", "a", 100),
        ("r2", "a", 250),
        ("r3", "b", 250),
        ("r4", "b", 400),
        ("r5", "c", 100),
        ("r6", "c", 150),
        ("r7", "d", 250),
        ("r10", "e", 250),
    ] {
        store.put_revision(&version(id, note_id, at, &[1])).unwrap();
    }
    store
        .put_revision(&event("r8", "d", "title", 260, Some("D")))
        .unwrap();
    let mut baseline = version("r9", "e", 100, &[1]);
    baseline.value = Some(BASELINE.into());
    store.put_revision(&baseline).unwrap();
    (dir, store)
}

#[test]
fn lists_every_plain_version_of_the_notes_a_sweep_weighs() {
    let (_dir, store) = compaction_world();
    let page = |from, to, after: &str, limit| -> Vec<String> {
        store
            .compactable_versions(from, to, after, limit)
            .unwrap()
            .into_iter()
            .map(|v| format!("{}/{}@{}", v.note_id, v.id, v.at))
            .collect()
    };
    let listed = |from, to| page(from, to, "", 500);
    // Each note's versions, newest first; e's baseline does not make two.
    assert_eq!(listed(200, 300), ["a/r2@250", "a/r1@100"]);
    assert_eq!(
        listed(0, 300),
        ["a/r2@250", "a/r1@100", "c/r6@150", "c/r5@100"]
    );
    assert_eq!(
        listed(0, 500),
        [
            "a/r2@250", "a/r1@100", "b/r4@400", "b/r3@250", "c/r6@150", "c/r5@100"
        ]
    );
    assert_eq!(listed(300, 500), ["b/r4@400", "b/r3@250"]);
    // A page at a time, by note.
    assert_eq!(page(0, 500, "", 1), ["a/r2@250", "a/r1@100"]);
    assert_eq!(
        page(0, 500, "a", 2),
        ["b/r4@400", "b/r3@250", "c/r6@150", "c/r5@100"]
    );
    assert!(page(0, 500, "c", 2).is_empty());
}

#[test]
fn compaction_deletes_only_plain_versions_and_records_the_sweep() {
    let (_dir, mut store) = compaction_world();
    let ids = |store: &Store, note_id| -> Vec<String> {
        store
            .list_revisions(note_id)
            .unwrap()
            .into_iter()
            .map(|r| r.id)
            .collect()
    };
    assert_eq!(store.last_compaction().unwrap(), None);
    // An event, a baseline and an unknown ID are never deleted.
    let named = ["r1", "r8", "r9", "zz"].map(String::from);
    store.compact_revisions(&named, None).unwrap();
    assert_eq!(ids(&store, "a"), ["r2"]);
    assert_eq!(ids(&store, "d"), ["r8", "r7"]);
    assert_eq!(ids(&store, "e"), ["r10", "r9"]);
    assert_eq!(store.last_compaction().unwrap(), None);
    store.compact_revisions(&[], Some(5000)).unwrap();
    assert_eq!(store.last_compaction().unwrap(), Some(5000));
    // A clock set back records the earlier time: the next sweep starts there.
    store
        .compact_revisions(&["r2".to_string()], Some(4000))
        .unwrap();
    assert_eq!(store.last_compaction().unwrap(), Some(4000));
    assert!(ids(&store, "a").is_empty());
}

#[test]
fn trashing_keeps_revisions_and_purging_deletes_them_for_good() {
    let (_dir, mut store) = temp_store();
    store.put_note(&note("a", "A", 10), &[]).unwrap();
    store.put_revision(&version("r1", "a", 1, &[1])).unwrap();
    let mut trashed = based_on(1, note("a", "A", 11));
    trashed.deleted_at = Some(11);
    trashed.deleted_hlc = Some("0000000000000011-0000-a".into());
    store.put_note(&trashed, &[]).unwrap();
    assert_eq!(store.list_revisions("a").unwrap().len(), 1);

    store
        .purge_note("a", 30, "0000000000000030-0000-a")
        .unwrap();
    assert!(store.list_revisions("a").unwrap().is_empty());
    // Late writes to a purged or unknown note are dropped.
    store.put_revision(&version("r2", "a", 31, &[1])).unwrap();
    store.put_revision(&version("r3", "zz", 31, &[1])).unwrap();
    assert!(store.list_revisions("a").unwrap().is_empty());
    assert!(store.list_revisions("zz").unwrap().is_empty());
}

#[test]
fn lists_activity_since_a_time() {
    let (_dir, mut store) = temp_store();
    // Created before `since`, written in it.
    let mut a = note("a", "A", 500);
    a.created_at = 10;
    store.put_note(&a, &[]).unwrap();
    store
        .put_revision(&version("r1", "a", 50, &[1, 2, 3, 4, 5]))
        .unwrap();
    store
        .put_revision(&version("r2", "a", 200, &[1, 2]))
        .unwrap();
    // Taken at the same time: ordered by length, then as stored.
    store
        .put_revision(&version("r3", "a", 250, &[1, 2, 3]))
        .unwrap();
    store.put_revision(&version("r4", "a", 250, &[1])).unwrap();
    // A title spelled like the marker is still a title change.
    store
        .put_revision(&event("r5", "a", "title", 300, Some(BASELINE)))
        .unwrap();
    store
        .put_revision(&event("r6", "a", "status", 300, Some("active")))
        .unwrap();
    // Created in the window; one in the Trash still counts.
    let mut b = note("b", "B", 150);
    b.created_at = 150;
    store.put_note(&b, &[]).unwrap();
    // A baseline is left out, but is the version before the next one.
    store
        .put_revision(&RevisionRecord {
            value: Some(BASELINE.into()),
            ..version("r8", "b", 160, &[1, 2, 3, 4])
        })
        .unwrap();
    store
        .put_revision(&version("r9", "b", 180, &[1, 2, 3, 4, 5, 6]))
        .unwrap();
    let mut d = note("d", "D", 170);
    d.created_at = 160;
    d.deleted_at = Some(170);
    d.deleted_hlc = Some("0000000000000170-0000-a".into());
    store.put_note(&d, &[]).unwrap();
    // Purged: left out with its history.
    let mut c = note("c", "C", 400);
    c.created_at = 400;
    store.put_note(&c, &[]).unwrap();
    store.put_revision(&version("r7", "c", 400, &[1])).unwrap();
    store
        .purge_note("c", 450, "0000000000000450-0000-a")
        .unwrap();

    let mut data = store.list_activity(100).unwrap();
    data.notes.sort_by(|x, y| x.id.cmp(&y.id));
    data.revisions.sort_by_key(|r| (r.at, r.length, r.previous));
    let created = |id: &str, created_at| ActivityNote {
        id: id.into(),
        created_at,
    };
    assert_eq!(data.notes, [created("b", 150), created("d", 160)]);
    let revision = |note_id: &str, kind: &str, at, length, previous| ActivityRevision {
        note_id: note_id.into(),
        kind: kind.into(),
        at,
        length,
        previous,
    };
    assert_eq!(
        data.revisions,
        [
            revision("b", "body", 180, Some(6), Some(4)),
            revision("a", "body", 200, Some(2), Some(5)),
            revision("a", "body", 250, Some(1), Some(2)),
            revision("a", "body", 250, Some(3), Some(1)),
            revision("a", "title", 300, None, None),
        ]
    );
    assert_eq!(
        store.list_activity(1_000).unwrap(),
        ActivityData {
            notes: Vec::new(),
            revisions: Vec::new()
        }
    );
}
