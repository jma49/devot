//! `devot append` (issue #477): the command hands its request over the single-instance socket, as
//! `devot a.md` does, and this module runs it through the frontmost main window's core, which
//! appends as one Yjs update the open editor takes as one undo step. Unlike files, an append is
//! answered after it ran: the command learns the outcome's code (`E_HEADING_NOT_FOUND`, say) or
//! that it was done. Devot is not brought forward: a script appends without taking the focus.
//! Logs carry the request's ID and codes, never the text.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{SyncSender, sync_channel};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewWindow};

pub(crate) const EVENT: &str = "devot://cli-append";
/// As the HTTP API's: a write may wait behind a save or a busy database.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(15);
/// Requests on their way at once; the window runs them one at a time.
const MAX_WAITING: usize = 16;
const CODE_MAX: usize = 80;

/// The note the text goes in, as the command named it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum Target {
    Id { id: String },
    Title { title: String },
}

/// What the main window gets (`readCliAppendRequest` in `src/renderer/src/cliAppend.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct Request {
    pub id: u64,
    pub target: Target,
    pub heading: Option<String>,
    pub position: &'static str,
    pub text: String,
}

type Outcome = Result<(), String>;

#[derive(Default)]
pub struct Appends {
    next: AtomicU64,
    waiting: Mutex<HashMap<u64, SyncSender<Outcome>>>,
}

impl Appends {
    fn wait(&self) -> Result<(u64, std::sync::mpsc::Receiver<Outcome>), &'static str> {
        let mut waiting = self.waiting.lock().map_err(|_| "E_CLI_APPEND_FAILED")?;
        if waiting.len() >= MAX_WAITING {
            return Err("E_CLI_APPEND_BUSY");
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        let (reply, answer) = sync_channel(1);
        waiting.insert(id, reply);
        Ok((id, answer))
    }

    /// False for an ID that is not waiting (answered already, timed out, or never asked).
    fn answer(&self, id: u64, answer: Outcome) -> bool {
        let reply = self.waiting.lock().ok().and_then(|mut w| w.remove(&id));
        reply.is_some_and(|reply| reply.send(answer).is_ok())
    }

    fn forget(&self, id: u64) {
        if let Ok(mut waiting) = self.waiting.lock() {
            waiting.remove(&id);
        }
    }

    /// Hands the request on with `emit` and waits for its outcome; `emit` is false when no window
    /// could take it. Tauri sends an event no window listens for without an error, so a window that
    /// is not listening yet shows as a timeout.
    pub(crate) fn ask(
        &self,
        append: &crate::cli::Append,
        timeout: Duration,
        emit: impl FnOnce(Request) -> bool,
    ) -> Outcome {
        let (id, answer) = self.wait()?;
        let request = Request {
            id,
            target: match &append.target {
                crate::cli::Target::Id(note) => Target::Id { id: note.clone() },
                crate::cli::Target::Title(title) => Target::Title {
                    title: title.clone(),
                },
            },
            heading: append.heading.clone(),
            position: append.position.as_str(),
            text: append.text.clone(),
        };
        if !emit(request) {
            self.forget(id);
            return Err("E_CLI_APPEND_UNAVAILABLE".into());
        }
        match answer.recv_timeout(timeout) {
            Ok(answer) => answer,
            Err(_) => {
                self.forget(id);
                log::warn!("W_CLI_APPEND_TIMEOUT {id}");
                Err("E_CLI_APPEND_TIMEOUT".into())
            }
        }
    }
}

/// The window's answer as it is passed on: done, or a code, never free text.
fn outcome(error: Option<String>) -> Outcome {
    match error {
        None => Ok(()),
        Some(code)
            if code.starts_with("E_")
                && (3..=CODE_MAX).contains(&code.len())
                && code
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_') =>
        {
            Err(code)
        }
        Some(_) => Err("E_CLI_APPEND_FAILED".into()),
    }
}

/// Runs a hand-off from `devot append` (its arguments as `cli::append_handoff_args` wrote them) and
/// answers once the window has. Not a hand-off of an append: `None`.
pub(crate) fn receive(app: &AppHandle, args: &[String]) -> Option<Outcome> {
    if !crate::cli::hands_off_append(args) {
        return None;
    }
    let Some(append) = crate::cli::parse_append_handoff(args) else {
        log::warn!("W_CLI_APPEND_REFUSED");
        return Some(Err("E_CLI_APPEND_INVALID".into()));
    };
    if crate::exit::quitting(app) {
        return Some(Err("E_APP_QUITTING".into()));
    }
    let Some(appends) = app.try_state::<Appends>() else {
        return Some(Err("E_CLI_APPEND_UNAVAILABLE".into()));
    };
    let result = appends.ask(&append, ANSWER_TIMEOUT, |request| {
        let id = request.id;
        let sent = crate::main_windows::emit_front(app, EVENT, request).is_ok();
        if sent {
            log::info!("I_CLI_APPEND {id}");
        }
        sent
    });
    if let Err(code) = &result {
        log::warn!("W_CLI_APPEND_FAILED {code}");
    }
    Some(result)
}

/// From the main window once it ran the request (`cliAppend.ts`).
#[tauri::command]
pub fn cli_append_done(
    window: WebviewWindow,
    appends: State<'_, Appends>,
    id: u64,
    error: Option<String>,
) -> Result<(), String> {
    if !crate::main_windows::is_main(window.label()) {
        return Err("E_CLI_APPEND_WINDOW".into());
    }
    if appends.answer(id, outcome(error)) {
        Ok(())
    } else {
        Err("E_CLI_APPEND_UNKNOWN".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{Append, Position};

    const ID: &str = "01890a5d-ac96-774b-bcce-b302099a8057";

    fn append() -> Append {
        Append {
            target: crate::cli::Target::Id(ID.into()),
            heading: Some("Log".into()),
            position: Position::Append,
            text: "- done".into(),
        }
    }

    #[test]
    fn hands_the_window_the_request_with_its_id_and_passes_the_answer_on_once() {
        let appends = std::sync::Arc::new(Appends::default());
        let answering = std::sync::Arc::clone(&appends);
        let asked = appends.ask(&append(), Duration::from_secs(5), |request| {
            assert_eq!(
                serde_json::to_value(&request).unwrap(),
                serde_json::json!({
                    "id": 1,
                    "target": { "kind": "id", "id": ID },
                    "heading": "Log",
                    "position": "append",
                    "text": "- done",
                })
            );
            std::thread::spawn(move || {
                assert!(answering.answer(1, Err("E_HEADING_NOT_FOUND".into())));
                assert!(!answering.answer(1, Ok(())), "answered already");
            });
            true
        });
        assert_eq!(asked, Err("E_HEADING_NOT_FOUND".into()));
        assert!(!appends.answer(7, Ok(())), "never asked");
    }

    #[test]
    fn a_request_no_window_takes_or_answers_in_time_fails_with_a_code() {
        let appends = Appends::default();
        assert_eq!(
            appends.ask(&append(), Duration::from_secs(5), |_| false),
            Err("E_CLI_APPEND_UNAVAILABLE".into())
        );
        assert_eq!(
            appends.ask(&append(), Duration::from_millis(20), |_| true),
            Err("E_CLI_APPEND_TIMEOUT".into())
        );
        assert!(appends.waiting.lock().unwrap().is_empty(), "forgotten");
    }

    #[test]
    fn takes_a_bounded_number_of_requests_at_once() {
        let appends = Appends::default();
        let mut held = Vec::new();
        for _ in 0..MAX_WAITING {
            held.push(appends.wait().unwrap());
        }
        assert_eq!(appends.wait().unwrap_err(), "E_CLI_APPEND_BUSY");
        drop(held);
    }

    #[test]
    fn passes_on_codes_from_the_window_and_nothing_else() {
        assert_eq!(outcome(None), Ok(()));
        assert_eq!(
            outcome(Some("E_HEADING_NOT_FOUND".into())),
            Err("E_HEADING_NOT_FOUND".into())
        );
        for other in ["", "E_", "oops", "E_lower", "E_A B", &"E_".repeat(60)] {
            assert_eq!(
                outcome(Some(other.into())),
                Err("E_CLI_APPEND_FAILED".into()),
                "{other}"
            );
        }
    }
}
