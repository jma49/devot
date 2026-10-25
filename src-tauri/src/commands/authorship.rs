//! The agent_writes index (docs/adr/0007-authorship-by-yjs-item-ids.md): the rows `note_put`
//! writes with a note, the list for the note list's mark and the sidebar's Agents section, and
//! marking a note's writes seen. The core derives the rows from untrusted records (another device,
//! devot-mcp, a later build), so every row is checked here again.

use super::notes::valid_note_id;
use crate::storage::{AgentWriteRow, AgentWriteSummary, Db, Write};
use tauri::State;

/// MAX_AGENT_WRITE_ROWS in src/core/authorship.ts (a policy test checks they match).
pub(crate) const MAX_AGENT_WRITE_ROWS: usize = 10_000;
/// MAX_WRITER_NAME_CHARS in src/core/authorship.ts.
const MAX_WRITER_NAME_CHARS: usize = 100;
/// MAX_AGENT_WRITES_LISTED in src/core/storage.ts.
const MAX_AGENT_WRITES_LISTED: u32 = 1_000;
const WRITER_KINDS: [&str; 3] = ["mcp", "http", "aiEdit"];
/// The largest whole number JavaScript holds exactly.
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// 64 random bits in base64url (newAuthorshipId).
fn valid_write_id(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// What cleanWriterName in src/core/authorship.ts can give: no control, line or paragraph
/// separator or bidirectional control, so a name cannot read as another.
fn valid_writer_name(name: &str) -> bool {
    name.chars().count() <= MAX_WRITER_NAME_CHARS
        && !name.chars().any(|c| {
            c.is_control()
                || matches!(
                    c,
                    '\u{2028}'
                        | '\u{2029}'
                        | '\u{061c}'
                        | '\u{200e}'
                        | '\u{200f}'
                        | '\u{202a}'..='\u{202e}'
                        | '\u{2066}'..='\u{2069}'
                )
        })
}

pub(crate) fn validate_agent_writes(rows: &[AgentWriteRow]) -> Result<(), &'static str> {
    if rows.len() > MAX_AGENT_WRITE_ROWS {
        return Err("E_NOTE_WRITES_INVALID");
    }
    let mut ids = std::collections::HashSet::with_capacity(rows.len());
    for row in rows {
        let valid = valid_write_id(&row.write_id)
            && WRITER_KINDS.contains(&row.kind.as_str())
            && valid_writer_name(&row.name)
            && (0..=MAX_SAFE_INTEGER).contains(&row.at)
            && ids.insert(row.write_id.as_str());
        if !valid {
            return Err("E_NOTE_WRITES_INVALID");
        }
    }
    Ok(())
}

fn validate_limit(limit: u32) -> Result<(), &'static str> {
    if limit == 0 || limit > MAX_AGENT_WRITES_LISTED {
        return Err("E_AGENT_WRITES_LIMIT_INVALID");
    }
    Ok(())
}

fn validate_seen(note_id: &str, write_ids: &[String]) -> Result<(), &'static str> {
    if !valid_note_id(note_id) {
        return Err("E_NOTE_ID_INVALID");
    }
    if write_ids.len() > MAX_AGENT_WRITE_ROWS || !write_ids.iter().all(|id| valid_write_id(id)) {
        return Err("E_AGENT_WRITES_INVALID");
    }
    Ok(())
}

#[tauri::command]
pub async fn agent_writes_list(
    db: State<'_, Db>,
    limit: u32,
) -> Result<Vec<AgentWriteSummary>, String> {
    validate_limit(limit).map_err(String::from)?;
    db.call(move |store| store.list_agent_writes(limit))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_writes_seen(
    db: State<'_, Db>,
    note_id: String,
    write_ids: Vec<String>,
) -> Result<(), String> {
    validate_seen(&note_id, &write_ids).map_err(String::from)?;
    db.write(Write::Bookkeeping, move |store| {
        store.mark_agent_writes_seen(&note_id, &write_ids)
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOTE: &str = "0192a6f0-0000-7000-8000-000000000001";

    fn row() -> AgentWriteRow {
        AgentWriteRow {
            write_id: "Ab3_-Zz09xQ".into(),
            kind: "mcp".into(),
            name: "Claude Code".into(),
            at: 1_790_000_000_000,
            created: false,
        }
    }

    #[test]
    fn takes_the_rows_the_core_derives() {
        assert_eq!(validate_agent_writes(&[]), Ok(()));
        assert_eq!(validate_agent_writes(&[row()]), Ok(()));
        let named = |name: &str| AgentWriteRow {
            name: name.into(),
            ..row()
        };
        assert_eq!(validate_agent_writes(&[named("")]), Ok(()));
        assert_eq!(
            validate_agent_writes(&[named(&"\u{1F600}".repeat(100))]),
            Ok(())
        );
        let aiedit = AgentWriteRow {
            kind: "aiEdit".into(),
            name: String::new(),
            ..row()
        };
        assert_eq!(validate_agent_writes(&[aiedit]), Ok(()));
    }

    #[test]
    fn refuses_rows_the_core_could_not_derive() {
        let refused = |row: AgentWriteRow| {
            assert_eq!(validate_agent_writes(&[row]), Err("E_NOTE_WRITES_INVALID"));
        };
        refused(AgentWriteRow {
            write_id: "short".into(),
            ..row()
        });
        refused(AgentWriteRow {
            write_id: "Ab3/+Zz09xQ".into(),
            ..row()
        });
        refused(AgentWriteRow {
            kind: "owner".into(),
            ..row()
        });
        for name in [
            "two\nlines",
            "bell\u{7}",
            "evil\u{202e}edoC",
            "line\u{2028}sep",
        ] {
            refused(AgentWriteRow {
                name: name.into(),
                ..row()
            });
        }
        refused(AgentWriteRow {
            name: "n".repeat(101),
            ..row()
        });
        refused(AgentWriteRow { at: -1, ..row() });
        refused(AgentWriteRow {
            at: MAX_SAFE_INTEGER + 1,
            ..row()
        });
        assert_eq!(
            validate_agent_writes(&[row(), row()]),
            Err("E_NOTE_WRITES_INVALID")
        );
        assert_eq!(
            validate_agent_writes(&vec![row(); MAX_AGENT_WRITE_ROWS + 1]),
            Err("E_NOTE_WRITES_INVALID")
        );
    }

    #[test]
    fn validates_the_list_and_seen_arguments() {
        assert_eq!(validate_limit(1), Ok(()));
        assert_eq!(validate_limit(MAX_AGENT_WRITES_LISTED), Ok(()));
        assert_eq!(validate_limit(0), Err("E_AGENT_WRITES_LIMIT_INVALID"));
        assert_eq!(
            validate_limit(MAX_AGENT_WRITES_LISTED + 1),
            Err("E_AGENT_WRITES_LIMIT_INVALID")
        );
        assert_eq!(validate_seen(NOTE, &["Ab3_-Zz09xQ".into()]), Ok(()));
        assert_eq!(validate_seen("../x", &[]), Err("E_NOTE_ID_INVALID"));
        assert_eq!(
            validate_seen(NOTE, &["x".into()]),
            Err("E_AGENT_WRITES_INVALID")
        );
        assert_eq!(
            validate_seen(NOTE, &vec!["Ab3_-Zz09xQ".into(); MAX_AGENT_WRITE_ROWS + 1]),
            Err("E_AGENT_WRITES_INVALID")
        );
    }
}
