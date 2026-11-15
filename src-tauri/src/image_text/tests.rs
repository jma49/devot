use std::sync::{Arc, Mutex};

use super::*;
use crate::storage::{FileRecord, NoteQuery, NoteRecord, TextCondition, TextField, Write};

const A: &str = "01900000-0000-7000-8000-00000000000a";
const B: &str = "01900000-0000-7000-8000-00000000000b";

fn fast() -> Pace {
    Pace {
        quiet: Duration::from_millis(40),
        poll: Duration::from_millis(10),
        batch: 2,
    }
}

/// Reads an image's bytes as its text, so a test says what each image holds; "fail" is unreadable.
#[derive(Clone, Default)]
struct Fake {
    read: Arc<Mutex<Vec<Vec<u8>>>>,
}

impl Reader for Fake {
    fn read(&mut self, image: &[u8]) -> Result<String, &'static str> {
        self.read.lock().unwrap().push(image.to_vec());
        match image {
            b"fail" => Err("E_TEST"),
            _ => Ok(String::from_utf8_lossy(image).into_owned()),
        }
    }
}

impl Fake {
    fn count(&self) -> usize {
        self.read.lock().unwrap().len()
    }
}

struct Library {
    _dir: tempfile::TempDir,
    db: Db,
    _worker: ImageText,
    reader: Fake,
}

fn library(pace: Pace) -> Library {
    let dir = tempfile::tempdir().unwrap();
    let db = Db::spawn(&dir.path().join("devot.sqlite")).unwrap();
    let reader = Fake::default();
    let made = reader.clone();
    let worker = ImageText::start(
        db.clone(),
        Box::new(move || Some(Box::new(made) as Box<dyn Reader>)),
        pace,
    );
    Library {
        _dir: dir,
        db,
        _worker: worker,
        reader,
    }
}

fn record(id: &str) -> NoteRecord {
    NoteRecord {
        id: id.into(),
        title: "Receipts".into(),
        title_hlc: "0000000000001-0000-test".into(),
        body_md: "kept for the taxes".into(),
        ydoc: vec![1, 2, 3],
        body_version: 0,
        book_id: None,
        book_hlc: String::new(),
        status: "none".into(),
        status_hlc: String::new(),
        pinned: false,
        pinned_hlc: String::new(),
        created_at: 1,
        updated_at: 1,
        dates_hlc: String::new(),
        deleted_at: None,
        deleted_hlc: None,
    }
}

fn put_image(db: &Db, note: &str, file: &str, data: &[u8]) {
    let note = note.to_owned();
    let file = FileRecord {
        id: file.into(),
        note_id: note.clone(),
        name: "scan.png".into(),
        mime: "image/png".into(),
        data: data.to_vec(),
        created_at: 1,
    };
    block_on(db.write(Write::Content, move |store| {
        if store.get_note(&note, true)?.is_none() {
            store.put_note(&record(&note), &[])?;
        }
        store.put_file(&file)
    }))
    .unwrap();
}

fn found(db: &Db, word: &str) -> Vec<String> {
    let query = NoteQuery {
        text: vec![TextCondition {
            field: TextField::Any,
            value: word.into(),
            negate: false,
        }],
        sets: Vec::new(),
        pinned: None,
    };
    block_on(db.call(move |store| store.search_notes(&query, 10)))
        .unwrap()
        .into_iter()
        .map(|hit| hit.id)
        .collect()
}

fn stale(db: &Db) -> usize {
    block_on(db.call(|store| store.stale_image_notes(100)))
        .unwrap()
        .len()
}

fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(10);
    while !done() {
        assert!(Instant::now() < until, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn an_image_is_read_once_saves_are_quiet_and_its_note_is_found_by_its_text() {
    let library = library(fast());
    put_image(&library.db, A, "f1", b"invoice 4471");
    wait_until("the image read", || stale(&library.db) == 0);
    assert_eq!(found(&library.db, "4471"), vec![A.to_owned()]);
    assert_eq!(library.reader.count(), 1);
}

#[test]
fn nothing_is_read_while_saves_keep_coming() {
    let library = library(Pace {
        quiet: Duration::from_millis(300),
        ..fast()
    });
    put_image(&library.db, A, "f1", b"invoice 4471");
    let until = Instant::now() + Duration::from_millis(600);
    while Instant::now() < until {
        block_on(library.db.write(Write::Body, |_| Ok(()))).unwrap();
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(library.reader.count(), 0);
    wait_until("the image read", || stale(&library.db) == 0);
    assert_eq!(library.reader.count(), 1);
}

#[test]
fn the_same_image_in_many_notes_is_read_once_and_batches_cover_them_all() {
    let library = library(fast());
    put_image(&library.db, A, "f1", b"boarding pass");
    put_image(&library.db, B, "f2", b"boarding pass");
    put_image(&library.db, A, "f3", b"gate 12");
    put_image(&library.db, A, "f4", b"seat 4c");
    put_image(&library.db, B, "f5", b"row 30");
    wait_until("every image read", || stale(&library.db) == 0);
    assert_eq!(library.reader.count(), 4);
    let mut both = found(&library.db, "boarding");
    both.sort();
    assert_eq!(both, vec![A.to_owned(), B.to_owned()]);
    assert_eq!(found(&library.db, "row 30"), vec![B.to_owned()]);
}

#[test]
fn an_unreadable_image_is_not_read_again() {
    let library = library(fast());
    put_image(&library.db, A, "f1", b"fail");
    wait_until("the image tried", || stale(&library.db) == 0);
    put_image(&library.db, B, "f2", b"fail");
    wait_until("the copy looked at", || stale(&library.db) == 0);
    assert_eq!(library.reader.count(), 1);
    assert!(found(&library.db, "fail").is_empty());
}

#[test]
fn without_a_reader_nothing_happens() {
    let dir = tempfile::tempdir().unwrap();
    let db = Db::spawn(&dir.path().join("devot.sqlite")).unwrap();
    let _worker = ImageText::start(db.clone(), Box::new(|| None), fast());
    put_image(&db, A, "f1", b"invoice 4471");
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(stale(&db), 1);
}

#[test]
fn long_text_is_clipped_on_a_character() {
    let text = "\u{53d1}".repeat(MAX_CHARS + 10);
    assert_eq!(clipped(&text).chars().count(), MAX_CHARS);
    assert_eq!(clipped("  short \n"), "short");
}
