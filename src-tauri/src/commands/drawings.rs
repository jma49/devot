//! The plugin drawings a note keeps (docs/adr/0030-plugin-drawings-sync-with-the-note.md). The list is checked here
//! as `checkDrawings` (src/core/plugins/drawings.ts) checks it, so a page cannot store one past the caps.

use std::collections::HashSet;

use tauri::State;

use super::notes::{valid_hlc, valid_note_id};
use crate::plugins::manifest::{is_id, is_language};
use crate::storage::{Db, KeptDrawing, NoteDrawings, Write};

/// MAX_DRAWING_BYTES, MAX_NOTE_DRAWINGS and MAX_NOTE_DRAWINGS_BYTES in src/core/plugins/drawings.ts.
const MAX_DRAWING_BYTES: usize = 256 * 1024;
const MAX_NOTE_DRAWINGS: usize = 32;
const MAX_NOTE_DRAWINGS_BYTES: usize = 1024 * 1024;

fn valid_drawing(drawing: &KeptDrawing) -> bool {
    is_id(&drawing.plugin_id)
        && is_language(&drawing.language)
        && drawing.hash.len() == 64
        && drawing
            .hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && matches!(drawing.appearance.as_str(), "light" | "dark")
        && !drawing.svg.is_empty()
        && drawing.svg.len() <= MAX_DRAWING_BYTES
}

fn validate(record: &NoteDrawings) -> Result<(), &'static str> {
    if !valid_note_id(&record.note_id) {
        return Err("E_NOTE_ID_INVALID");
    }
    if !valid_hlc(&record.hlc) || record.drawings.len() > MAX_NOTE_DRAWINGS {
        return Err("E_NOTE_DRAWINGS_INVALID");
    }
    let mut keys = HashSet::new();
    let mut bytes = 0;
    for d in &record.drawings {
        let key = (&d.plugin_id, &d.language, &d.hash, &d.appearance);
        if !valid_drawing(d) || !keys.insert(key) {
            return Err("E_NOTE_DRAWINGS_INVALID");
        }
        bytes += d.svg.len();
    }
    if bytes > MAX_NOTE_DRAWINGS_BYTES {
        return Err("E_NOTE_DRAWINGS_INVALID");
    }
    Ok(())
}

#[tauri::command]
pub async fn note_drawings_get(
    db: State<'_, Db>,
    note_id: String,
) -> Result<Option<NoteDrawings>, String> {
    if !valid_note_id(&note_id) {
        return Err("E_NOTE_ID_INVALID".into());
    }
    db.call(move |store| store.get_note_drawings(&note_id))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn note_drawings_put(db: State<'_, Db>, record: NoteDrawings) -> Result<(), String> {
    validate(&record).map_err(String::from)?;
    db.write(Write::Content, move |store| {
        store.put_note_drawings(&record)
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drawing(hash: char) -> KeptDrawing {
        KeptDrawing {
            plugin_id: "com.example.graphviz".into(),
            language: "dot".into(),
            hash: hash.to_string().repeat(64),
            appearance: "light".into(),
            svg: "<svg/>".into(),
        }
    }

    fn record(drawings: Vec<KeptDrawing>) -> NoteDrawings {
        NoteDrawings {
            note_id: "0192a6f0-0000-7000-8000-000000000001".into(),
            drawings,
            hlc: "0001728000000000-0000-mac".into(),
        }
    }

    #[test]
    fn takes_a_list_within_the_caps() {
        assert_eq!(validate(&record(vec![])), Ok(()));
        let light = drawing('a');
        let dark = KeptDrawing {
            appearance: "dark".into(),
            ..drawing('a')
        };
        assert_eq!(validate(&record(vec![light, dark])), Ok(()));
    }

    #[test]
    fn refuses_a_malformed_list() {
        let big = |n: usize| KeptDrawing {
            svg: "x".repeat(n),
            ..drawing('a')
        };
        let bad = [
            vec![drawing('a'), drawing('a')],
            vec![KeptDrawing {
                hash: "A".repeat(64),
                ..drawing('a')
            }],
            vec![KeptDrawing {
                hash: "a".repeat(63),
                ..drawing('a')
            }],
            vec![KeptDrawing {
                appearance: "sepia".into(),
                ..drawing('a')
            }],
            vec![KeptDrawing {
                plugin_id: "devot.core".into(),
                ..drawing('a')
            }],
            vec![KeptDrawing {
                language: "mermaid".into(),
                ..drawing('a')
            }],
            vec![KeptDrawing {
                svg: String::new(),
                ..drawing('a')
            }],
            vec![big(MAX_DRAWING_BYTES + 1)],
            (0..=MAX_NOTE_DRAWINGS)
                .map(|i| KeptDrawing {
                    hash: format!("{i:064x}"),
                    ..drawing('a')
                })
                .collect(),
            (0..5)
                .map(|i| KeptDrawing {
                    hash: format!("{i:064x}"),
                    ..big(MAX_DRAWING_BYTES - 1)
                })
                .collect(),
        ];
        for drawings in bad {
            assert_eq!(
                validate(&record(drawings.clone())),
                Err("E_NOTE_DRAWINGS_INVALID"),
                "{}",
                drawings.len()
            );
        }
        let mut stale = record(vec![]);
        stale.hlc = "now".into();
        assert_eq!(validate(&stale), Err("E_NOTE_DRAWINGS_INVALID"));
        stale = record(vec![]);
        stale.note_id = "x".into();
        assert_eq!(validate(&stale), Err("E_NOTE_ID_INVALID"));
    }
}
