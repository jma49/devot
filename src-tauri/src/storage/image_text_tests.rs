use crate::storage::{FileRecord, NoteQuery, NoteRecord, Result, Store, TextCondition, TextField};

fn store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("devot.sqlite")).unwrap();
    (dir, store)
}

fn note(id: &str, title: &str, body: &str, updated_at: i64) -> NoteRecord {
    NoteRecord {
        id: id.into(),
        title: title.into(),
        title_hlc: format!("{updated_at:013}-0000-test"),
        body_md: body.into(),
        ydoc: vec![1, 2, 3],
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

fn file(id: &str, note_id: &str, mime: &str, data: &[u8]) -> FileRecord {
    FileRecord {
        id: id.into(),
        note_id: note_id.into(),
        name: format!("{id}.png"),
        mime: mime.into(),
        data: data.to_vec(),
        created_at: 1,
    }
}

fn rowid(store: &Store, id: &str) -> i64 {
    store
        .conn
        .query_row("SELECT rowid FROM notes WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .unwrap()
}

fn texts(store: &Store, ids: &[String]) -> Result<Vec<(String, String)>> {
    Ok(store
        .image_texts(ids)?
        .into_iter()
        .map(|(id, text, _)| (id, text))
        .collect())
}

fn version(store: &Store, id: &str) -> i64 {
    store
        .image_text_versions()
        .unwrap()
        .into_iter()
        .find(|(note, _)| note == id)
        .map_or(0, |(_, version)| version)
}

fn hash(data: &[u8]) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    Sha256::digest(data).to_vec()
}

/// What the worker does for one note, with `read` standing in for the system's recognizer.
fn read_images(store: &mut Store, note: i64, read: impl Fn(&[u8]) -> String) {
    while let Some(image) = store.unhashed_image(note).unwrap() {
        let hash = hash(&image.data);
        if !store.has_image_text(&hash).unwrap() {
            store.put_image_text(&hash, &read(&image.data)).unwrap();
        }
        store.put_file_hash(&image.file_id, &hash).unwrap();
    }
    store.refresh_image_text(note).unwrap();
}

fn search(store: &Store, terms: &[(&str, TextField, bool)]) -> Vec<String> {
    let query = NoteQuery {
        text: terms
            .iter()
            .map(|(value, field, negate)| TextCondition {
                field: *field,
                value: (*value).into(),
                negate: *negate,
            })
            .collect(),
        sets: Vec::new(),
        pinned: None,
    };
    store
        .search_notes(&query, 50)
        .unwrap()
        .into_iter()
        .map(|found| found.id)
        .collect()
}

fn words<'a>(terms: &[&'a str]) -> Vec<(&'a str, TextField, bool)> {
    terms.iter().map(|t| (*t, TextField::Any, false)).collect()
}

fn as_text(data: &[u8]) -> String {
    String::from_utf8(data.to_vec()).unwrap()
}

#[test]
fn an_image_marks_its_note_to_be_read_and_other_files_do_not() {
    let (_dir, mut store) = store();
    store.put_note(&note("a", "A", "", 1), &[]).unwrap();
    store.put_note(&note("b", "B", "", 1), &[]).unwrap();
    store
        .put_file(&file("f1", "a", "image/png", b"one"))
        .unwrap();
    store
        .put_file(&file("f2", "b", "application/pdf", b"two"))
        .unwrap();
    assert_eq!(
        store.stale_image_notes(10).unwrap(),
        vec![rowid(&store, "a")]
    );
}

#[test]
fn reads_each_image_of_a_note_once_and_the_same_image_once_in_any_note() {
    let (_dir, mut store) = store();
    store.put_note(&note("a", "A", "", 1), &[]).unwrap();
    store.put_note(&note("b", "B", "", 1), &[]).unwrap();
    store
        .put_file(&file("f1", "a", "image/png", b"invoice 42"))
        .unwrap();
    store
        .put_file(&file("f2", "b", "image/png", b"invoice 42"))
        .unwrap();
    let reads = std::cell::Cell::new(0);
    for note in store.stale_image_notes(10).unwrap() {
        read_images(&mut store, note, |data| {
            reads.set(reads.get() + 1);
            as_text(data)
        });
    }
    assert_eq!(reads.get(), 1);
    assert!(store.stale_image_notes(10).unwrap().is_empty());
    assert_eq!(
        texts(&store, &["a".into(), "b".into()]).unwrap(),
        vec![
            ("a".to_string(), "invoice 42".to_string()),
            ("b".to_string(), "invoice 42".to_string())
        ]
    );
}

#[test]
fn a_notes_text_joins_its_images_in_the_order_added_and_leaves_out_those_without_text() {
    let (_dir, mut store) = store();
    store.put_note(&note("a", "A", "", 1), &[]).unwrap();
    let mut first = file("f1", "a", "image/png", b"first page");
    first.created_at = 1;
    let mut blank = file("f2", "a", "image/jpeg", b"");
    blank.created_at = 2;
    let mut second = file("f3", "a", "image/png", b"second page");
    second.created_at = 3;
    for f in [&second, &blank, &first] {
        store.put_file(f).unwrap();
    }
    let a = rowid(&store, "a");
    read_images(&mut store, a, as_text);
    assert_eq!(
        texts(&store, &["a".into()]).unwrap(),
        vec![("a".to_string(), "first page\nsecond page".to_string())]
    );
}

#[test]
fn the_version_moves_only_when_a_notes_text_changes() {
    let (_dir, mut store) = store();
    store.put_note(&note("a", "A", "", 1), &[]).unwrap();
    store
        .put_file(&file("f1", "a", "image/png", b"receipt"))
        .unwrap();
    let a = rowid(&store, "a");
    read_images(&mut store, a, as_text);
    let first = version(&store, "a");
    assert!(first > 0);
    store.put_file(&file("f2", "a", "image/png", b"")).unwrap();
    read_images(&mut store, a, as_text);
    assert_eq!(version(&store, "a"), first);
    store
        .put_file(&file("f3", "a", "image/png", b"total"))
        .unwrap();
    read_images(&mut store, a, as_text);
    assert!(version(&store, "a") > first);
}

#[test]
fn a_deleted_image_takes_its_text_out_of_the_note() {
    let (_dir, mut store) = store();
    store.put_note(&note("a", "A", "", 1), &[]).unwrap();
    store
        .put_file(&file("f1", "a", "image/png", b"keep"))
        .unwrap();
    store
        .put_file(&file("f2", "a", "image/png", b"drop"))
        .unwrap();
    let a = rowid(&store, "a");
    read_images(&mut store, a, as_text);
    store
        .conn
        .execute("DELETE FROM files WHERE id = 'f2'", [])
        .unwrap();
    assert_eq!(store.stale_image_notes(10).unwrap(), vec![a]);
    read_images(&mut store, a, as_text);
    assert_eq!(
        texts(&store, &["a".into()]).unwrap(),
        vec![("a".to_string(), "keep".to_string())]
    );
    store
        .conn
        .execute("DELETE FROM files WHERE id = 'f1'", [])
        .unwrap();
    read_images(&mut store, a, as_text);
    assert!(texts(&store, &["a".into()]).unwrap().is_empty());
    assert_eq!(version(&store, "a"), 0);
}

#[test]
fn a_purged_notes_images_leave_with_their_text() {
    let (_dir, mut store) = store();
    store.put_note(&note("a", "A", "", 1), &[]).unwrap();
    store
        .put_file(&file("f1", "a", "image/png", b"secret plan"))
        .unwrap();
    let a = rowid(&store, "a");
    read_images(&mut store, a, as_text);
    store
        .trash_and_purge("a", 5, "0000000000005-0000-test")
        .unwrap();
    for note in store.stale_image_notes(10).unwrap() {
        read_images(&mut store, note, as_text);
    }
    let rows: i64 = store
        .conn
        .query_row("SELECT count(*) FROM note_image_text", [], |row| row.get(0))
        .unwrap();
    assert_eq!(rows, 0);
}

#[test]
fn an_image_handed_to_another_note_moves_its_text() {
    let (_dir, mut store) = store();
    store.put_note(&note("a", "A", "", 1), &[]).unwrap();
    store.put_note(&note("b", "B", "", 1), &[]).unwrap();
    store
        .put_file(&file("f1", "a", "image/png", b"moving text"))
        .unwrap();
    for note in store.stale_image_notes(10).unwrap() {
        read_images(&mut store, note, as_text);
    }
    store
        .conn
        .execute("UPDATE files SET note_id = 'b' WHERE id = 'f1'", [])
        .unwrap();
    for note in store.stale_image_notes(10).unwrap() {
        read_images(&mut store, note, as_text);
    }
    assert_eq!(
        texts(&store, &["a".into(), "b".into()]).unwrap(),
        vec![("b".to_string(), "moving text".to_string())]
    );
}

#[test]
fn a_hash_is_not_kept_for_a_file_deleted_while_it_was_read() {
    let (_dir, mut store) = store();
    store.put_note(&note("a", "A", "", 1), &[]).unwrap();
    store
        .put_file(&file("f1", "a", "image/png", b"gone"))
        .unwrap();
    let image = store.unhashed_image(rowid(&store, "a")).unwrap().unwrap();
    store
        .conn
        .execute("DELETE FROM files WHERE id = 'f1'", [])
        .unwrap();
    store
        .put_file_hash(&image.file_id, &hash(&image.data))
        .unwrap();
    let kept: i64 = store
        .conn
        .query_row("SELECT count(*) FROM file_hashes", [], |row| row.get(0))
        .unwrap();
    assert_eq!(kept, 0);
}

fn with_image(store: &mut Store, id: &str, title: &str, body: &str, image: &str, at: i64) {
    store.put_note(&note(id, title, body, at), &[]).unwrap();
    store
        .put_file(&file(
            &format!("{id}-image"),
            id,
            "image/png",
            image.as_bytes(),
        ))
        .unwrap();
    let note = rowid(store, id);
    read_images(store, note, as_text);
}

#[test]
fn search_finds_a_note_by_the_text_in_its_images() {
    let (_dir, mut store) = store();
    with_image(
        &mut store,
        "a",
        "Trip",
        "Tickets below.",
        "Boarding pass gate B12",
        1,
    );
    store
        .put_note(&note("b", "Other", "Nothing here", 2), &[])
        .unwrap();
    assert_eq!(search(&store, &words(&["boarding"])), vec!["a"]);
    assert_eq!(search(&store, &words(&["tickets", "boarding"])), vec!["a"]);
    assert!(search(&store, &words(&["boarding", "missing"])).is_empty());
}

#[test]
fn notes_with_the_words_in_their_text_come_before_notes_with_them_only_in_images() {
    let (_dir, mut store) = store();
    with_image(&mut store, "image", "Scan", "", "quarterly report", 9);
    store
        .put_note(&note("text", "Notes", "the quarterly report draft", 1), &[])
        .unwrap();
    assert_eq!(
        search(&store, &words(&["quarterly"])),
        vec!["text", "image"]
    );
}

#[test]
fn image_text_counts_as_body_never_as_title() {
    let (_dir, mut store) = store();
    with_image(&mut store, "a", "Trip", "", "Boarding pass", 1);
    assert!(search(&store, &[("boarding", TextField::Title, false)]).is_empty());
    assert_eq!(
        search(&store, &[("boarding", TextField::Body, false)]),
        vec!["a"]
    );
    assert_eq!(
        search(
            &store,
            &[
                ("trip", TextField::Title, false),
                ("boarding", TextField::Any, false)
            ]
        ),
        vec!["a"]
    );
    assert!(
        search(
            &store,
            &[
                ("boarding", TextField::Title, false),
                ("pass", TextField::Any, false)
            ]
        )
        .is_empty()
    );
}

#[test]
fn an_excluded_word_leaves_out_notes_whose_images_hold_it() {
    let (_dir, mut store) = store();
    with_image(&mut store, "a", "Trip one", "", "draft copy", 1);
    store.put_note(&note("b", "Trip two", "", 2), &[]).unwrap();
    assert_eq!(
        search(
            &store,
            &[
                ("trip", TextField::Any, false),
                ("draft", TextField::Any, true)
            ]
        ),
        vec!["b"]
    );
    assert_eq!(
        search(
            &store,
            &[
                ("trip", TextField::Any, false),
                ("dr", TextField::Any, true)
            ]
        ),
        vec!["b"]
    );
}

#[test]
fn a_short_word_is_found_in_the_text_of_images_too() {
    let (_dir, mut store) = store();
    with_image(&mut store, "a", "Scan", "", "\u{53d1}\u{7968} 2026", 1);
    store.put_note(&note("b", "Plain", "", 2), &[]).unwrap();
    assert_eq!(search(&store, &words(&["\u{53d1}\u{7968}"])), vec!["a"]);
    assert_eq!(
        search(&store, &words(&["scan", "\u{53d1}\u{7968}"])),
        vec!["a"]
    );
}

#[test]
fn a_trashed_notes_images_are_not_searched() {
    let (_dir, mut store) = store();
    with_image(&mut store, "a", "Trip", "", "Boarding pass", 1);
    store
        .conn
        .execute("UPDATE notes SET deleted_at = 2 WHERE id = 'a'", [])
        .unwrap();
    assert!(search(&store, &words(&["boarding"])).is_empty());
}

#[test]
fn a_note_found_by_its_images_shows_an_excerpt_of_their_text() {
    let (_dir, mut store) = store();
    with_image(
        &mut store,
        "a",
        "Trip",
        "Tickets below.",
        "Boarding pass gate B12",
        1,
    );
    let found = store.search_notes(
        &NoteQuery {
            text: vec![TextCondition {
                field: TextField::Any,
                value: "gate".into(),
                negate: false,
            }],
            sets: Vec::new(),
            pinned: None,
        },
        10,
    );
    assert_eq!(
        found.unwrap()[0].excerpt.as_deref(),
        Some("Boarding pass gate B12")
    );
}
