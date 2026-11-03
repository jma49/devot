//! `devot append` (issue #477), handed over the single-instance socket like `devot a.md` and run
//! through a main window's core, which answers with the outcome (`cli_append_done`). A request
//! waits here until a main window has asked for requests (`cli_append_take`, again after a reload),
//! as links do, so one sent while Devot is still starting is not lost. Devot is not brought forward.
//! Logs carry the request's ID and codes, never the text.

use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{SyncSender, sync_channel};
use std::time::Duration;

use serde::Serialize;
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewWindow, Window, WindowEvent};

use crate::main_windows::is_main;

pub(crate) const EVENT: &str = "devot://cli-append";
/// Covers a window still loading after a launch, then the write itself (the HTTP API allows 15 s).
const ANSWER_TIMEOUT: Duration = Duration::from_secs(30);
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

/// The main windows that take requests, and the requests none has taken yet.
#[derive(Default)]
struct Inbox {
    ready: BTreeSet<String>,
    held: Vec<Request>,
}

impl Inbox {
    /// The window a request goes to: the frontmost when it is ready, else any ready one.
    fn target(&self, front: Option<&str>) -> Option<String> {
        front
            .filter(|label| self.ready.contains(*label))
            .map(str::to_owned)
            .or_else(|| self.ready.iter().next().cloned())
    }

    fn take(&mut self, label: &str) -> Vec<Request> {
        self.ready.insert(label.to_owned());
        std::mem::take(&mut self.held)
    }
}

#[derive(Default)]
pub struct Appends {
    next: AtomicU64,
    waiting: Mutex<HashMap<u64, SyncSender<Outcome>>>,
    inbox: Mutex<Inbox>,
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
        if let Ok(mut inbox) = self.inbox.lock() {
            inbox.held.retain(|request| request.id != id);
        }
    }

    /// Sends the request to a ready main window with `emit`, or holds it for the first that asks,
    /// and waits for its outcome. `emit` is false when the event could not be sent.
    pub(crate) fn ask(
        &self,
        append: &crate::cli::Append,
        timeout: Duration,
        front: Option<&str>,
        emit: impl FnOnce(&str, Request) -> bool,
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
        let target = {
            let mut inbox = self.inbox.lock().map_err(|_| "E_CLI_APPEND_FAILED")?;
            let target = inbox.target(front);
            if target.is_none() {
                inbox.held.push(request.clone());
            }
            target
        };
        if let Some(label) = target
            && !emit(&label, request)
        {
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

    /// The requests held for the first window to ask; `label` takes requests from now on.
    fn take(&self, label: &str) -> Vec<Request> {
        self.inbox
            .lock()
            .map(|mut inbox| inbox.take(label))
            .unwrap_or_default()
    }

    fn page_started(&self, label: &str) {
        if let Ok(mut inbox) = self.inbox.lock() {
            inbox.ready.remove(label);
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
    // Asked before the inbox is locked: off the main thread a window's getters wait for it.
    let front = crate::main_windows::front_label(app);
    let result = appends.ask(
        &append,
        ANSWER_TIMEOUT,
        front.as_deref(),
        |label, request| {
            let id = request.id;
            let sent = app.emit_to(label, EVENT, request).is_ok();
            if sent {
                log::info!("I_CLI_APPEND {id}");
            }
            sent
        },
    );
    if let Err(code) = &result {
        log::warn!("W_CLI_APPEND_FAILED {code}");
    }
    Some(result)
}

pub(crate) fn on_page_load<R: Runtime>(webview: &tauri::Webview<R>, payload: &PageLoadPayload<'_>) {
    if !is_main(webview.label()) || payload.event() != PageLoadEvent::Started {
        return;
    }
    if let Some(appends) = webview.try_state::<Appends>() {
        appends.page_started(webview.label());
    }
}

pub(crate) fn on_window_event(window: &Window, event: &WindowEvent) {
    if !matches!(event, WindowEvent::Destroyed) || !is_main(window.label()) {
        return;
    }
    if let Some(appends) = window.app_handle().try_state::<Appends>() {
        appends.page_started(window.label());
    }
}

/// From the main window once it listens for requests (`cliAppend.ts`): what waited meanwhile.
#[tauri::command]
pub fn cli_append_take(
    window: WebviewWindow,
    appends: State<'_, Appends>,
) -> Result<Vec<Request>, String> {
    if !is_main(window.label()) {
        return Err("E_CLI_APPEND_WINDOW".into());
    }
    Ok(appends.take(window.label()))
}

/// From the main window once it ran the request (`cliAppend.ts`).
#[tauri::command]
pub fn cli_append_done(
    window: WebviewWindow,
    appends: State<'_, Appends>,
    id: u64,
    error: Option<String>,
) -> Result<(), String> {
    if !is_main(window.label()) {
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
    use std::sync::Arc;

    const ID: &str = "01890a5d-ac96-774b-bcce-b302099a8057";

    fn append() -> Append {
        Append {
            target: crate::cli::Target::Id(ID.into()),
            heading: Some("Log".into()),
            position: Position::Append,
            text: "- done".into(),
        }
    }

    fn ready(appends: &Appends, label: &str) {
        assert!(appends.take(label).is_empty());
    }

    #[test]
    fn hands_the_front_window_the_request_with_its_id_and_passes_the_answer_on_once() {
        let appends = Arc::new(Appends::default());
        ready(&appends, "main");
        ready(&appends, "main-2");
        let answering = Arc::clone(&appends);
        let asked = appends.ask(
            &append(),
            Duration::from_secs(5),
            Some("main-2"),
            |label, request| {
                assert_eq!(label, "main-2");
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
            },
        );
        assert_eq!(asked, Err("E_HEADING_NOT_FOUND".into()));
        assert!(!appends.answer(7, Ok(())), "never asked");
        // A front window that is not ready (reloading) does not take it; a ready one does.
        appends.page_started("main-2");
        let sent = appends.ask(
            &append(),
            Duration::from_millis(20),
            Some("main-2"),
            |label, _| {
                assert_eq!(label, "main");
                true
            },
        );
        assert_eq!(sent, Err("E_CLI_APPEND_TIMEOUT".into()));
    }

    #[test]
    fn holds_a_request_until_a_window_asks_and_forgets_one_that_timed_out() {
        let appends = Arc::new(Appends::default());
        let taking = Arc::clone(&appends);
        let taker = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            let held = taking.take("main");
            assert_eq!(held.len(), 1);
            assert!(taking.answer(held[0].id, Ok(())));
        });
        let asked = appends.ask(&append(), Duration::from_secs(5), Some("main"), |_, _| {
            panic!("no window is ready")
        });
        assert_eq!(asked, Ok(()));
        taker.join().unwrap();
        assert!(appends.take("main").is_empty());

        let late = appends.ask(&append(), Duration::from_millis(20), None, |_, _| true);
        assert_eq!(late, Err("E_CLI_APPEND_TIMEOUT".into()));
        assert!(
            appends.take("main-2").is_empty(),
            "forgotten with its answer"
        );
    }

    #[test]
    fn a_request_no_window_takes_or_answers_in_time_fails_with_a_code() {
        let appends = Appends::default();
        ready(&appends, "main");
        assert_eq!(
            appends.ask(&append(), Duration::from_secs(5), None, |_, _| false),
            Err("E_CLI_APPEND_UNAVAILABLE".into())
        );
        assert_eq!(
            appends.ask(&append(), Duration::from_millis(20), None, |_, _| true),
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
