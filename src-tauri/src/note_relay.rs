//! Carries what one window's core tells the others about a note (`src/core/noteRelay.ts`): a Yjs update,
//! a state vector asking for what the others hold, a title, a stored write, that the note was trashed
//! or purged, or that it was put back from the Trash. Every window that edits notes (`may_relay`) hears what the others send about a note it may
//! show: every main window about every note, a note window about its own. The message is checked here
//! and passed on as it came; Yjs data stays the base64 the page sent and is never decoded.

use crate::commands::notes::{MAX_TITLE_CHARS, MAX_YDOC_BYTES, valid_hlc, valid_note_id};
use crate::main_windows::is_main;
use crate::note_window;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, EventTarget, Manager, WebviewWindow};

pub const EVENT: &str = "devot://note-relay";
const MAX_DATA_CHARS: usize = MAX_YDOC_BYTES.div_ceil(3) * 4;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum NoteRelayMessage {
    Update {
        note_id: String,
        data: String,
    },
    Want {
        note_id: String,
        data: String,
    },
    Title {
        note_id: String,
        title: String,
        hlc: String,
    },
    Saved {
        note_id: String,
        updated_at: u64,
        /// The write changed the note's agent_writes rows: the main windows read theirs again.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        authored: bool,
    },
    /// The note went to the Trash, or with `purged` was deleted for good: its window turns read-only.
    Gone {
        note_id: String,
        purged: bool,
    },
    /// The note was put back from the Trash: its window can edit it again.
    Back {
        note_id: String,
    },
}

fn valid_base64(data: &str) -> bool {
    !data.is_empty()
        && data.len() <= MAX_DATA_CHARS
        && data.len().is_multiple_of(4)
        && data.trim_end_matches('=').len() + 2 >= data.len()
        && data
            .trim_end_matches('=')
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

impl NoteRelayMessage {
    fn note_id(&self) -> &str {
        match self {
            Self::Update { note_id, .. }
            | Self::Want { note_id, .. }
            | Self::Title { note_id, .. }
            | Self::Saved { note_id, .. }
            | Self::Gone { note_id, .. }
            | Self::Back { note_id } => note_id,
        }
    }

    fn check(&self) -> Result<(), &'static str> {
        if !valid_note_id(self.note_id()) {
            return Err("E_NOTE_ID_INVALID");
        }
        match self {
            Self::Update { data, .. } | Self::Want { data, .. } if !valid_base64(data) => {
                Err("E_NOTE_RELAY_DATA_INVALID")
            }
            Self::Title { title, .. }
                if title.chars().count() > MAX_TITLE_CHARS || title.contains(['\n', '\r']) =>
            {
                Err("E_NOTE_TITLE_INVALID")
            }
            Self::Title { hlc, .. } if !valid_hlc(hlc) => Err("E_NOTE_HLC_INVALID"),
            Self::Saved { updated_at, .. } if *updated_at > MAX_SAFE_INTEGER => {
                Err("E_NOTE_TIME_INVALID")
            }
            // Every kind named, not `_`, so a kind added later must say what it checks.
            Self::Update { .. }
            | Self::Want { .. }
            | Self::Title { .. }
            | Self::Saved { .. }
            | Self::Gone { .. }
            | Self::Back { .. } => Ok(()),
        }
    }
}

/// The windows whose core edits notes and saves them.
pub fn may_relay(label: &str) -> bool {
    is_main(label) || note_window::note_of(label).is_some()
}

/// Every other window that may show the note.
fn targets<'a>(sender: &str, note_id: &str, labels: impl Iterator<Item = &'a str>) -> Vec<&'a str> {
    labels
        .filter(|label| *label != sender)
        .filter(|label| is_main(label) || note_window::note_of(label) == Some(note_id))
        .collect()
}

#[tauri::command]
pub fn note_relay_send(
    app: AppHandle,
    window: WebviewWindow,
    message: NoteRelayMessage,
) -> Result<(), String> {
    if !may_relay(window.label()) {
        return Err("E_NOTE_RELAY_WINDOW".into());
    }
    message.check()?;
    let windows = app.webview_windows();
    for label in targets(
        window.label(),
        message.note_id(),
        windows.keys().map(String::as_str),
    ) {
        // Each window listens for its own (`noteRelay.ts`), so nothing reaches another.
        if app
            .emit_to(EventTarget::webview_window(label), EVENT, &message)
            .is_err()
        {
            log::warn!("W_NOTE_RELAY_EMIT_FAILED");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0192a6f0-0000-7000-8000-000000000001";
    const OTHER: &str = "0192a6f0-0000-7000-8000-000000000002";

    fn update(data: &str) -> NoteRelayMessage {
        NoteRelayMessage::Update {
            note_id: ID.into(),
            data: data.into(),
        }
    }

    /// Each kind as the page hands it over, which `noteRelay.test.ts` checks the core sends.
    fn sent_by_the_page() -> Vec<serde_json::Value> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/note-relay.json");
        let mut fixture: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).expect("E_TEST_FIXTURES"))
                .expect("E_TEST_FIXTURES");
        serde_json::from_value(fixture["messages"].take()).expect("E_TEST_FIXTURES")
    }

    fn read(json: &serde_json::Value) -> NoteRelayMessage {
        serde_json::from_value(json.clone()).unwrap_or_else(|e| panic!("{json}: {e}"))
    }

    #[test]
    fn reads_each_kind_the_core_sends() {
        let own = note_window::label_for(ID);
        let labels = ["main", "main-2", own.as_str(), "settings"];
        for json in sent_by_the_page() {
            let message = read(&json);
            assert_eq!(message.check(), Ok(()), "{json}");
            assert_eq!(
                targets("main", message.note_id(), labels.into_iter()),
                ["main-2", own.as_str()],
                "{json}"
            );
            assert_eq!(
                targets(&own, message.note_id(), labels.into_iter()),
                ["main", "main-2"],
                "{json}"
            );
        }
        assert!(
            serde_json::from_str::<NoteRelayMessage>(&format!(
                r#"{{"kind":"update","noteId":"{ID}","data":"AAA=","more":1}}"#
            ))
            .is_err()
        );
        assert!(serde_json::from_str::<NoteRelayMessage>(r#"{"kind":"delete"}"#).is_err());
    }

    #[test]
    fn passes_on_a_message_as_it_came() {
        for json in sent_by_the_page() {
            assert_eq!(serde_json::to_value(read(&json)).unwrap(), json);
        }
    }

    #[test]
    fn takes_a_note_gone_from_the_library_like_the_other_kinds() {
        let gone = serde_json::from_str::<NoteRelayMessage>(
            r#"{"kind":"gone","noteId":"n1","purged":true}"#,
        )
        .unwrap();
        assert_eq!(gone.note_id(), "n1");
        assert_eq!(gone.check(), Err("E_NOTE_ID_INVALID"));
        let trashed = read(&serde_json::json!({ "kind": "gone", "noteId": ID, "purged": false }));
        assert_eq!(trashed.check(), Ok(()));
        let own = note_window::label_for(ID);
        let labels = ["main", "main-2", own.as_str(), "settings"];
        assert_eq!(
            targets("main-2", trashed.note_id(), labels.into_iter()),
            targets("main-2", update("AAA=").note_id(), labels.into_iter())
        );
        assert!(
            serde_json::from_str::<NoteRelayMessage>(&format!(
                r#"{{"kind":"gone","noteId":"{ID}"}}"#
            ))
            .is_err()
        );
    }

    #[test]
    fn refuses_what_no_core_sends() {
        assert_eq!(update("AAA=").check(), Ok(()));
        assert_eq!(update("AA==").check(), Ok(()));
        for data in ["", "AAA", "A===", "AA-A", "AAAA\n", "AA=A"] {
            assert_eq!(
                update(data).check(),
                Err("E_NOTE_RELAY_DATA_INVALID"),
                "{data:?}"
            );
        }
        let too_long = "A".repeat(MAX_DATA_CHARS + 4);
        assert_eq!(update(&too_long).check(), Err("E_NOTE_RELAY_DATA_INVALID"));
        let bad_id = NoteRelayMessage::Want {
            note_id: "note".into(),
            data: "AAA=".into(),
        };
        assert_eq!(bad_id.check(), Err("E_NOTE_ID_INVALID"));
        let title = |title: &str, hlc: &str| NoteRelayMessage::Title {
            note_id: ID.into(),
            title: title.into(),
            hlc: hlc.into(),
        };
        assert_eq!(title("a\nb", "h").check(), Err("E_NOTE_TITLE_INVALID"));
        assert_eq!(
            title(&"x".repeat(MAX_TITLE_CHARS + 1), "h").check(),
            Err("E_NOTE_TITLE_INVALID")
        );
        assert_eq!(title("Plan", "").check(), Err("E_NOTE_HLC_INVALID"));
        let late = NoteRelayMessage::Saved {
            note_id: ID.into(),
            updated_at: MAX_SAFE_INTEGER + 1,
            authored: false,
        };
        assert_eq!(late.check(), Err("E_NOTE_TIME_INVALID"));
    }

    #[test]
    fn reaches_every_main_window_and_the_note_s_own_window_only() {
        let own = note_window::label_for(ID);
        let other = note_window::label_for(OTHER);
        let labels = [
            "main",
            "main-2",
            own.as_str(),
            other.as_str(),
            "settings",
            "quick-capture",
        ];
        assert_eq!(
            targets("main", ID, labels.into_iter()),
            ["main-2", own.as_str()]
        );
        assert_eq!(
            targets("main-2", ID, labels.into_iter()),
            ["main", own.as_str()]
        );
        assert_eq!(targets(&own, ID, labels.into_iter()), ["main", "main-2"]);
        assert_eq!(
            targets(&other, OTHER, labels.into_iter()),
            ["main", "main-2"]
        );
    }

    #[test]
    fn only_windows_that_edit_notes_may_relay() {
        assert!(may_relay("main"));
        assert!(may_relay("main-2"));
        assert!(may_relay(&note_window::label_for(ID)));
        assert!(!may_relay("settings"));
        assert!(!may_relay("quick-capture"));
        assert!(!may_relay("note-anything"));
        assert!(!may_relay("main-x"));
    }
}
