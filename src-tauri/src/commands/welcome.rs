//! The first-launch notes (docs/specs/first-launch-notes.md), from the copy this build bundles:
//! `welcome_seed.json`, the window's own seed as src/renderer/src/welcome/content.test.ts writes it.
//! It is the one write of notes a library takes without a licence (`Write::Welcome`), so the caller
//! gives only the clock stamp and the time, never content, and it writes only into a library that
//! has never held these notes (`Store::seed_welcome`).

use super::files::detect_image;
use super::notes::valid_hlc;
use crate::storage::{BookRecord, Db, FileRecord, NoteRecord, WelcomeNote, Write};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use tauri::State;

const SEED: &str = include_str!("welcome_seed.json");
/// The latest time JavaScript's Date holds.
const MAX_AT: i64 = 8_640_000_000_000_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Seed {
    book_id: String,
    book_name: String,
    notes: Vec<SeedNote>,
    files: Vec<SeedFile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SeedNote {
    id: String,
    title: String,
    body_md: String,
    ydoc: String,
    pinned: bool,
    links: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SeedFile {
    id: String,
    note_id: String,
    name: String,
    data: String,
}

struct Rows {
    book: BookRecord,
    notes: Vec<WelcomeNote>,
    files: Vec<FileRecord>,
}

fn rows(hlc: &str, at: i64) -> Result<Rows, &'static str> {
    const INVALID: &str = "E_WELCOME_SEED_INVALID";
    let seed: Seed = serde_json::from_str(SEED).map_err(|_| INVALID)?;
    let book = BookRecord {
        id: seed.book_id.clone(),
        name: seed.book_name,
        name_hlc: hlc.into(),
        parent_id: None,
        parent_hlc: hlc.into(),
        created_at: at,
        updated_at: at,
        deleted_at: None,
        deleted_hlc: None,
        ai_access: false,
        ai_access_hlc: String::new(),
        sort_key: String::new(),
        sort_key_hlc: String::new(),
        icon: None,
        icon_color: None,
        icon_hlc: String::new(),
    };
    let notes = seed
        .notes
        .into_iter()
        .map(|note| {
            Ok(WelcomeNote {
                record: NoteRecord {
                    ydoc: STANDARD.decode(note.ydoc).map_err(|_| INVALID)?,
                    id: note.id,
                    title: note.title,
                    title_hlc: hlc.into(),
                    body_md: note.body_md,
                    // As note_put stores a new note's first write.
                    body_version: 1,
                    book_id: Some(seed.book_id.clone()),
                    book_hlc: hlc.into(),
                    status: "none".into(),
                    status_hlc: String::new(),
                    pinned: note.pinned,
                    pinned_hlc: if note.pinned {
                        hlc.into()
                    } else {
                        String::new()
                    },
                    created_at: at,
                    updated_at: at,
                    dates_hlc: String::new(),
                    deleted_at: None,
                    deleted_hlc: None,
                },
                links: note.links,
            })
        })
        .collect::<Result<_, &'static str>>()?;
    let files = seed
        .files
        .into_iter()
        .map(|file| {
            let data = STANDARD.decode(file.data).map_err(|_| INVALID)?;
            Ok(FileRecord {
                mime: detect_image(&data).ok_or(INVALID)?.into(),
                id: file.id,
                note_id: file.note_id,
                name: file.name,
                data,
                created_at: at,
            })
        })
        .collect::<Result<_, &'static str>>()?;
    Ok(Rows { book, notes, files })
}

pub(crate) async fn seed(db: &Db, hlc: String, at: i64) -> Result<bool, String> {
    if !valid_hlc(&hlc) {
        return Err("E_WELCOME_HLC_INVALID".into());
    }
    if !(0..=MAX_AT).contains(&at) {
        return Err("E_WELCOME_TIME_INVALID".into());
    }
    let Rows { book, notes, files } = rows(&hlc, at).map_err(String::from)?;
    let seeded = db
        .write(Write::Welcome, move |store| {
            store.seed_welcome(&book, &notes, &files)
        })
        .await
        .map_err(|e| e.to_string())?;
    if seeded {
        log::info!("I_WELCOME_SEEDED");
    }
    Ok(seeded)
}

/// Answers whether it wrote: false once the library holds anything.
#[tauri::command]
pub async fn welcome_seed(db: State<'_, Db>, hlc: String, at: i64) -> Result<bool, String> {
    seed(&db, hlc, at).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::licence::{Gate, testing};
    use crate::storage::StorageError;
    use std::sync::Arc;
    use tauri::async_runtime::block_on;

    const HLC: &str = "0000001760000000-0000-mac1";
    const AT: i64 = 1_760_000_000_000;
    const WELCOME: &str = "00000000-0000-7000-8000-000000000011";
    const EXAMPLE: &str = "00000000-0000-7000-8000-000000000012";
    const IMAGE: &str = "00000000-0000-7000-8000-000000000013";
    const MINE: &str = "0192a6f0-0000-7000-8000-000000000001";

    fn note(id: &str) -> NoteRecord {
        NoteRecord {
            id: id.into(),
            title: "Mine".into(),
            title_hlc: HLC.into(),
            body_md: "Mine\n".into(),
            ydoc: vec![0],
            body_version: 0,
            book_id: None,
            book_hlc: String::new(),
            status: "none".into(),
            status_hlc: String::new(),
            pinned: false,
            pinned_hlc: String::new(),
            created_at: AT,
            updated_at: AT,
            dates_hlc: String::new(),
            deleted_at: None,
            deleted_hlc: None,
        }
    }

    /// A library on a temporary file, gated as a build whose trial is over and that holds no
    /// licence (an App Store install before the Trial or Devot Pro is bought refuses the same).
    fn locked() -> (tempfile::TempDir, Db) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::spawn(&dir.path().join("devot.sqlite")).unwrap();
        let licence = testing::licence(dir.path(), true);
        let gate = Gate::of(&licence);
        db.guard(Arc::new(move |what| gate.require_write(what)));
        (dir, db)
    }

    fn open() -> (tempfile::TempDir, Db) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::spawn(&dir.path().join("devot.sqlite")).unwrap();
        (dir, db)
    }

    fn note_ids(db: &Db) -> Vec<String> {
        let mut ids: Vec<_> = block_on(db.call(|store| store.list_notes()))
            .unwrap()
            .into_iter()
            .map(|n| n.id)
            .collect();
        ids.sort();
        ids
    }

    #[test]
    fn a_new_library_without_a_licence_gets_the_welcome_notes() {
        let (_dir, db) = locked();
        assert!(block_on(seed(&db, HLC.into(), AT)).unwrap());
        assert_eq!(note_ids(&db), [WELCOME, EXAMPLE]);
        let books = block_on(db.call(|store| store.list_books())).unwrap();
        assert_eq!(books.len(), 1);
        assert_eq!(books[0].name, "Getting started");
        let welcome = block_on(db.call(|store| store.get_note(WELCOME, false)))
            .unwrap()
            .unwrap();
        assert!(welcome.pinned);
        assert_eq!(welcome.book_id.as_deref(), Some(books[0].id.as_str()));
        assert_eq!((welcome.created_at, welcome.updated_at), (AT, AT));
        let image = block_on(db.call(|store| store.get_file(IMAGE))).unwrap();
        assert_eq!(
            image.map(|f| (f.note_id, f.mime)),
            Some((EXAMPLE.to_string(), "image/png".to_string()))
        );
        let backlinks = block_on(db.call(|store| store.list_backlinks(WELCOME, "", 10))).unwrap();
        assert_eq!(
            backlinks.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
            [EXAMPLE]
        );
    }

    #[test]
    fn the_welcome_exception_opens_no_other_write() {
        let (_dir, db) = locked();
        block_on(seed(&db, HLC.into(), AT)).unwrap();
        for what in [Write::Body, Write::Content] {
            let refused = block_on(db.write(what, |store| store.put_note(&note(WELCOME), &[])));
            assert!(matches!(
                refused,
                Err(StorageError::Refused("E_LICENCE_REQUIRED"))
            ));
        }
        let welcome = block_on(db.call(|store| store.get_note(WELCOME, false)))
            .unwrap()
            .unwrap();
        assert_ne!(welcome.title, "Mine");
    }

    #[test]
    fn the_welcome_notes_are_written_once() {
        let (_dir, db) = locked();
        assert!(block_on(seed(&db, HLC.into(), AT)).unwrap());
        assert!(!block_on(seed(&db, "0000001760000001-0000-mac1".into(), AT + 1)).unwrap());
        let welcome = block_on(db.call(|store| store.get_note(WELCOME, false)))
            .unwrap()
            .unwrap();
        assert_eq!(welcome.title_hlc, HLC);
    }

    #[test]
    fn a_library_that_holds_anything_is_not_seeded() {
        let (_dir, db) = open();
        block_on(db.write(Write::Content, |store| store.put_note(&note(MINE), &[]))).unwrap();
        assert!(!block_on(seed(&db, HLC.into(), AT)).unwrap());
        assert_eq!(note_ids(&db).len(), 1);
        assert!(
            block_on(db.call(|store| store.list_books()))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn a_library_holding_only_templates_is_still_seeded() {
        let (_dir, db) = open();
        let templates: BookRecord = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-7000-8000-000000000001",
            "name": "Templates",
            "nameHlc": HLC,
            "parentId": null,
            "parentHlc": "",
            "createdAt": AT,
            "updatedAt": AT,
            "deletedAt": null,
            "deletedHlc": null,
        }))
        .unwrap();
        let mut template = note(MINE);
        template.book_id = Some(templates.id.clone());
        block_on(db.write(Write::Content, move |store| {
            store.put_book(&templates)?;
            store.put_note(&template, &[])
        }))
        .unwrap();
        assert!(block_on(seed(&db, HLC.into(), AT)).unwrap());
        assert_eq!(note_ids(&db), [WELCOME, EXAMPLE, MINE]);
    }

    #[test]
    fn a_library_with_a_note_in_the_trash_is_not_seeded() {
        let (_dir, db) = open();
        let mut trashed = note(MINE);
        trashed.deleted_at = Some(AT);
        trashed.deleted_hlc = Some(HLC.into());
        block_on(db.write(Write::Content, move |store| store.put_note(&trashed, &[]))).unwrap();
        assert!(!block_on(seed(&db, HLC.into(), AT)).unwrap());
        assert!(
            block_on(db.call(|store| store.list_books()))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn a_library_whose_welcome_notes_were_purged_is_not_seeded_again() {
        let (_dir, db) = open();
        block_on(seed(&db, HLC.into(), AT)).unwrap();
        block_on(db.write(Write::Content, |store| {
            for id in [WELCOME, EXAMPLE] {
                let mut gone = store.get_note(id, false)?.unwrap();
                gone.deleted_at = Some(AT + 1);
                gone.deleted_hlc = Some("0000001760000001-0000-mac1".into());
                store.put_note(&gone, &[])?;
                store.purge_note(id, AT + 2, "0000001760000002-0000-mac1")?;
            }
            let mut book = store.list_books()?.remove(0);
            book.deleted_at = Some(AT + 3);
            book.deleted_hlc = Some("0000001760000003-0000-mac1".into());
            store.put_book(&book)
        }))
        .unwrap();
        assert!(note_ids(&db).is_empty());
        assert!(!block_on(seed(&db, "0000001760000004-0000-mac1".into(), AT + 4)).unwrap());
        assert!(note_ids(&db).is_empty());
        assert!(
            block_on(db.call(|store| store.list_books()))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn a_stamp_or_time_of_another_shape_is_refused() {
        let (_dir, db) = locked();
        for (hlc, at, code) in [
            ("9999999999999999-0000-mac1", AT, "E_WELCOME_HLC_INVALID"),
            ("not a stamp", AT, "E_WELCOME_HLC_INVALID"),
            (HLC, -1, "E_WELCOME_TIME_INVALID"),
        ] {
            assert_eq!(block_on(seed(&db, hlc.into(), at)), Err(code.to_string()));
        }
        assert!(note_ids(&db).is_empty());
    }

    #[test]
    fn the_bundled_seed_holds_only_the_fixed_first_launch_ids() {
        let Rows { book, notes, files } = rows(HLC, AT).unwrap();
        assert_eq!(book.id, "00000000-0000-7000-8000-000000000010");
        let ids: Vec<_> = notes.iter().map(|n| n.record.id.as_str()).collect();
        assert_eq!(ids, [WELCOME, EXAMPLE]);
        assert_eq!(
            files.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(),
            [IMAGE]
        );
        for WelcomeNote { record, links } in &notes {
            assert!(!record.ydoc.is_empty() && !record.body_md.is_empty());
            assert!(links.iter().all(|l| ids.contains(&l.as_str())));
        }
    }
}
