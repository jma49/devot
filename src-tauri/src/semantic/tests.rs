use super::commands::{SemanticQuery, search, validate};
use super::embedder::hashed::Hashed;
use super::*;
use crate::storage::{
    NoteQuery, NoteRecord, SetCondition, SetKind, TextCondition, TextField, Write,
};

const A: &str = "01900000-0000-7000-8000-00000000000a";
const B: &str = "01900000-0000-7000-8000-00000000000b";
const C: &str = "01900000-0000-7000-8000-00000000000c";

fn fast() -> Pace {
    Pace {
        quiet: Duration::from_millis(40),
        poll: Duration::from_millis(10),
        rescan: Duration::from_secs(600),
        batch: 2,
    }
}

fn record(id: &str, title: &str, body: &str, at: i64) -> NoteRecord {
    let hlc = format!("{at:013}-0000-test");
    NoteRecord {
        id: id.into(),
        title: title.into(),
        title_hlc: hlc.clone(),
        body_md: body.into(),
        ydoc: vec![1, 2, 3, at as u8],
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

struct Library {
    _dir: tempfile::TempDir,
    db: Db,
    semantic: Semantic,
    model: Hashed,
}

fn library(notes: &[NoteRecord]) -> Library {
    library_paced(notes, fast())
}

fn library_paced(notes: &[NoteRecord], pace: Pace) -> Library {
    let dir = tempfile::tempdir().unwrap();
    let db = Db::spawn(&dir.path().join("devot.sqlite")).unwrap();
    for note in notes {
        put(&db, note.clone());
    }
    let model = Hashed::default();
    let made = model.clone();
    let semantic = Semantic::start(
        db.clone(),
        dir.path().join(FILE),
        Box::new(move || Some(Box::new(made) as Box<dyn Embedder>)),
        Gate::open(),
        pace,
    );
    Library {
        _dir: dir,
        db,
        semantic,
        model,
    }
}

fn put(db: &Db, note: NoteRecord) {
    tauri::async_runtime::block_on(db.write(Write::Content, move |store| {
        let stored = store
            .get_note(&note.id, true)?
            .map_or(0, |n| n.body_version);
        store.put_note(
            &NoteRecord {
                body_version: stored,
                ..note
            },
            &[],
        )
    }))
    .unwrap();
}

fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(10);
    while !done() {
        assert!(Instant::now() < until, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn ready(library: &Library, notes: u64) {
    wait_until("the index", || {
        library.semantic.status() == Status::Ready { notes }
    });
}

fn query(text: &str) -> SemanticQuery {
    SemanticQuery {
        text: text.into(),
        filter: NoteQuery {
            text: Vec::new(),
            sets: Vec::new(),
            pinned: None,
        },
        limit: 10,
        passages: false,
    }
}

fn found(library: &Library, query: SemanticQuery) -> Vec<String> {
    tauri::async_runtime::block_on(search(&library.semantic, &library.db, query))
        .unwrap()
        .into_iter()
        .map(|hit| hit.note.id)
        .collect()
}

/// Passages embedded for the index: what the model read with a title in front, not a query.
fn embedded(library: &Library) -> usize {
    library
        .model
        .embedded
        .lock()
        .unwrap()
        .iter()
        .filter(|text| text.contains(". "))
        .count()
}

#[test]
fn indexes_every_live_note_and_finds_the_closest_passages_first() {
    let library = library(&[
        record(
            A,
            "Garden",
            "Tomatoes need sun and water every morning.",
            10,
        ),
        record(B, "Taxes", "File the forms before April.", 11),
        record(
            C,
            "Trip",
            "Pack the tent. Water the garden tomatoes before leaving.",
            12,
        ),
    ]);
    ready(&library, 3);
    assert_eq!(found(&library, query("water tomatoes")), vec![A, C]);
    let hits = tauri::async_runtime::block_on(search(
        &library.semantic,
        &library.db,
        SemanticQuery {
            passages: true,
            ..query("forms April")
        },
    ))
    .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].note.id, B);
    assert_eq!(
        hits[0].note.excerpt.as_deref(),
        Some("File the forms before April.")
    );
    assert_eq!(
        hits[0].passage.as_deref(),
        Some("File the forms before April.")
    );
    assert!(hits[0].score > MIN_SCORE);
}

#[test]
fn the_filter_keeps_only_notes_the_search_would_show() {
    let mut pinned = record(A, "Garden", "Water the tomatoes.", 10);
    pinned.pinned = true;
    pinned.pinned_hlc = "0000000000010-0000-test".into();
    let mut active = record(B, "Garden too", "Water the roses and tomatoes.", 11);
    active.status = "active".into();
    active.status_hlc = "0000000000011-0000-test".into();
    let library = library(&[
        pinned,
        active,
        record(C, "Garden", "Water, tomatoes and draft.", 12),
    ]);
    ready(&library, 3);
    let mut only_pinned = query("water tomatoes");
    only_pinned.filter.pinned = Some(true);
    assert_eq!(found(&library, only_pinned), vec![A]);
    let mut not_active = query("water tomatoes");
    not_active.filter.sets.push(SetCondition {
        kind: SetKind::Status,
        ids: vec!["active".into()],
        negate: true,
    });
    let mut ids = found(&library, not_active);
    ids.sort();
    assert_eq!(ids, vec![A, C]);
    let mut without_draft = query("water tomatoes");
    without_draft.filter.text.push(TextCondition {
        field: TextField::Any,
        value: "draft".into(),
        negate: true,
    });
    let mut ids = found(&library, without_draft);
    ids.sort();
    assert_eq!(ids, vec![A, B]);
}

#[test]
fn an_edit_indexes_that_note_again_and_a_change_of_its_fields_alone_does_not() {
    let library = library(&[
        record(A, "Garden", "Water the tomatoes.", 10),
        record(B, "Taxes", "File the forms.", 11),
    ]);
    ready(&library, 2);
    let before = embedded(&library);
    let mut pinned = record(A, "Garden", "Water the tomatoes.", 20);
    pinned.pinned = true;
    pinned.pinned_hlc = "0000000000020-0000-test".into();
    put(&library.db, pinned);
    put(
        &library.db,
        record(B, "Taxes", "Call the accountant about receipts.", 21),
    );
    wait_until("the edit", || {
        found(&library, query("accountant receipts")) == vec![B.to_string()]
    });
    ready(&library, 2);
    assert_eq!(
        embedded(&library) - before,
        1,
        "only the edited note's one passage"
    );
    assert!(found(&library, query("forms")).is_empty());
}

#[test]
fn a_trashed_note_leaves_the_index() {
    let library = library(&[
        record(A, "Garden", "Water the tomatoes.", 10),
        record(B, "Taxes", "File the forms.", 11),
    ]);
    ready(&library, 2);
    let mut trashed = record(A, "Garden", "Water the tomatoes.", 20);
    trashed.deleted_at = Some(20);
    trashed.deleted_hlc = Some("0000000000020-0000-test".into());
    put(&library.db, trashed);
    ready(&library, 1);
    assert!(found(&library, query("water tomatoes")).is_empty());
}

#[test]
fn a_new_model_revision_indexes_every_note_again_at_the_next_start() {
    let dir = tempfile::tempdir().unwrap();
    let db = Db::spawn(&dir.path().join("devot.sqlite")).unwrap();
    put(&db, record(A, "Garden", "Water the tomatoes.", 10));
    let start = |model: Hashed| {
        Semantic::start(
            db.clone(),
            dir.path().join(FILE),
            Box::new(move || Some(Box::new(model) as Box<dyn Embedder>)),
            Gate::open(),
            fast(),
        )
    };
    let first = Hashed::default();
    let semantic = start(first.clone());
    wait_until("the first index", || {
        semantic.status() == Status::Ready { notes: 1 }
    });
    drop(semantic);
    let again = Hashed::default();
    let semantic = start(again.clone());
    wait_until("the restart", || {
        semantic.status() == Status::Ready { notes: 1 }
    });
    assert!(
        again.embedded.lock().unwrap().is_empty(),
        "the same model reuses the index"
    );
    drop(semantic);
    let newer = Hashed::default();
    *newer.revision.lock().unwrap() = 2;
    let semantic = start(newer.clone());
    wait_until("the new model's index", || {
        semantic.status() == Status::Ready { notes: 1 }
            && !newer.embedded.lock().unwrap().is_empty()
    });
}

#[test]
fn without_a_model_a_search_is_refused_and_nothing_is_indexed() {
    let dir = tempfile::tempdir().unwrap();
    let db = Db::spawn(&dir.path().join("devot.sqlite")).unwrap();
    let semantic = Semantic::start(
        db.clone(),
        dir.path().join(FILE),
        Box::new(|| None),
        Gate::open(),
        fast(),
    );
    wait_until("unavailable", || semantic.status() == Status::Unavailable);
    let answer = tauri::async_runtime::block_on(search(&semantic, &db, query("anything")));
    assert_eq!(answer.unwrap_err(), UNAVAILABLE);
    assert!(!dir.path().join(FILE).exists());
}

#[test]
fn indexing_waits_for_saves_to_be_quiet() {
    let pace = Pace {
        quiet: Duration::from_millis(250),
        ..fast()
    };
    let library = library_paced(&[], pace);
    ready(&library, 0);
    for at in 0..30 {
        put(
            &library.db,
            record(A, "Garden", &format!("Water {at}"), 10 + at),
        );
        std::thread::sleep(Duration::from_millis(10));
        assert_eq!(
            embedded(&library),
            0,
            "nothing is embedded while saves go on"
        );
    }
    ready(&library, 1);
    assert!(embedded(&library) > 0);
}

#[test]
fn queries_are_validated_before_anything_runs() {
    assert_eq!(validate(&query(" \n")), Err("E_SEMANTIC_TEXT_INVALID"));
    assert_eq!(
        validate(&query(&"x".repeat(1001))),
        Err("E_SEMANTIC_TEXT_INVALID")
    );
    assert_eq!(
        validate(&SemanticQuery {
            limit: 0,
            ..query("a")
        }),
        Err("E_SEMANTIC_LIMIT_INVALID")
    );
    assert_eq!(
        validate(&SemanticQuery {
            limit: 51,
            ..query("a")
        }),
        Err("E_SEMANTIC_LIMIT_INVALID")
    );
    let mut positive = query("a");
    positive.filter.text.push(TextCondition {
        field: TextField::Any,
        value: "b".into(),
        negate: false,
    });
    assert_eq!(validate(&positive), Err("E_SEMANTIC_FILTER_INVALID"));
    let mut bad_ids = query("a");
    bad_ids.filter.sets.push(SetCondition {
        kind: SetKind::Book,
        ids: vec!["not an id".into()],
        negate: false,
    });
    assert_eq!(validate(&bad_ids), Err("E_SEARCH_IDS_INVALID"));
    assert_eq!(validate(&query("water")), Ok(()));
}
