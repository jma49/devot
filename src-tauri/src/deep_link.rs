//! The app's URL scheme, registered with macOS through the bundle's Info.plist (`plugins.deep-link`
//! in tauri.conf.json): `devot://note/<id>` opens the note and `devot://command/<id>` runs one of
//! [`URL_COMMANDS`]. Debug builds answer to `devot-dev://` instead ([`SCHEME`]), so a development
//! bundle never takes the links meant for an installed Devot.
//! Every URL is checked here, whole, before the page sees anything of it: the page gets a [`Link`],
//! never the URL. A refused URL is logged by its code alone (`W_DEEP_LINK_REFUSED`), never its
//! text.
//! `devot://file/<id>` names attachments inside the window
//! (`register_asynchronous_uri_scheme_protocol` in lib.rs); that protocol lives in the web view
//! alone and this module refuses such a URL from another app.
//! Links wait in an [`Inbox`] until the main window has asked for them (`deep_link_take`; again
//! after a reload) and while the Settings window is open. A second launch does not open the data
//! folder: the single-instance plugin hands its arguments to this process ([`on_second_instance`])
//! and ends it. The `devot` command hands files over the same way (`cli`).

use std::collections::VecDeque;
use std::sync::Mutex;

use serde::Serialize;
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Emitter, Manager, Runtime, Window, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;

use crate::commands::notes::valid_note_id;
use crate::{MAIN_WINDOW, settings};

pub(crate) const RELEASE_SCHEME: &str = "devot";
pub(crate) const DEBUG_SCHEME: &str = "devot-dev";
pub(crate) const SCHEME: &str = if cfg!(debug_assertions) {
    DEBUG_SCHEME
} else {
    RELEASE_SCHEME
};

/// The commands a URL may run: each one only shows something (a view, a
/// mode, a dialog, the palette). Nothing that makes, trashes, deletes,
/// moves, imports, exports, edits or writes the clipboard, so a page that
/// opens a link over and over cannot change the library.
/// `deepLink.ts` lists the same (a test compares them).
pub(crate) const URL_COMMANDS: &[&str] = &[
    "palette.open",
    "view.allNotes",
    "view.trash",
    "view.focus",
    "view.togglePreview",
    "view.split",
    "view.edit",
    "view.preview",
    "app.backups",
    "app.checkForUpdates",
];

/// Longer than any URL accepted (`devot-dev://note/` and an ID is 53).
const MAX_URL_LEN: usize = 96;
const MAX_PER_EVENT: usize = 4;
const MAX_HELD: usize = 16;
pub(crate) const EVENT: &str = "devot://open-url";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Link {
    Note {
        id: String,
    },
    Command {
        id: &'static str,
    },
    /// Files from the `devot` command (`cli`); no URL makes one.
    Import {
        scan: crate::import::Scan,
        notebook: Option<String>,
        first: Option<String>,
    },
}

/// Exact: no query, fragment, escapes, trailing slash or other case. Returns the code of the refusal otherwise.
pub(crate) fn parse(url: &str, scheme: &str) -> Result<Link, &'static str> {
    if url.len() > MAX_URL_LEN {
        return Err("E_URL_TOO_LONG");
    }
    let rest = url
        .strip_prefix(scheme)
        .and_then(|rest| rest.strip_prefix("://"))
        .ok_or("E_URL_SCHEME")?;
    let (host, id) = rest.split_once('/').ok_or("E_URL_PATH")?;
    match host {
        // Canonical lowercase UUIDv7 only: nothing else fits, a `/`, `?`
        // or `#` included.
        "note" if valid_note_id(id) => Ok(Link::Note { id: id.to_owned() }),
        "note" => Err("E_URL_NOTE_ID"),
        "command" => URL_COMMANDS
            .iter()
            .find(|command| **command == id)
            .map(|command| Link::Command { id: command })
            .ok_or("E_URL_COMMAND"),
        _ => Err("E_URL_HOST"),
    }
}

#[derive(Debug, Default)]
pub(crate) struct Inbox {
    /// The page has asked for the links (it listens from then on), and has
    /// not reloaded since.
    ready: bool,
    settings_open: bool,
    held: VecDeque<Link>,
}

impl Inbox {
    fn arrive(&mut self, link: Link) -> Vec<Link> {
        if self.held.len() < MAX_HELD {
            self.held.push_back(link);
        } else {
            log::warn!("W_DEEP_LINK_DROPPED");
        }
        self.release()
    }

    fn take(&mut self) -> Vec<Link> {
        self.ready = true;
        self.release()
    }

    fn page_started(&mut self) {
        self.ready = false;
    }

    fn settings(&mut self, open: bool) -> Vec<Link> {
        self.settings_open = open;
        self.release()
    }

    fn release(&mut self) -> Vec<Link> {
        if !self.ready || self.settings_open {
            return Vec::new();
        }
        self.held.drain(..).collect()
    }
}

#[derive(Default)]
pub struct DeepLinks(Mutex<Inbox>);

impl DeepLinks {
    fn with<T>(&self, f: impl FnOnce(&mut Inbox) -> T) -> T {
        let mut inbox = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        f(&mut inbox)
    }

    /// Changes the inbox and sends what it releases, under its lock, so links
    /// reach the page in the order they came, whatever thread they came on.
    fn update<R: Runtime>(&self, app: &AppHandle<R>, f: impl FnOnce(&mut Inbox) -> Vec<Link>) {
        self.with(|inbox| {
            for link in f(inbox) {
                if app.emit_to(MAIN_WINDOW, EVENT, &link).is_err() {
                    log::warn!("W_DEEP_LINK_EMIT_FAILED");
                }
            }
        });
    }
}

/// Follows the URLs macOS opens the app with (`RunEvent::Opened`, through the
/// deep-link plugin). Called from setup, before the event loop runs, so no
/// URL comes earlier.
pub(crate) fn listen(app: &tauri::App) {
    let handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls().iter().take(MAX_PER_EVENT) {
            receive(&handle, url.as_str());
        }
    });
}

pub(crate) fn on_second_instance<R: Runtime>(app: &AppHandle<R>, args: Vec<String>, _cwd: String) {
    bring_forward(app);
    if crate::cli::receive_open(app, &args) {
        return;
    }
    let prefix = format!("{SCHEME}:");
    for url in args
        .iter()
        .skip(1)
        .filter(|arg| arg.starts_with(&prefix))
        .take(MAX_PER_EVENT)
    {
        receive(app, url);
    }
}

fn receive<R: Runtime>(app: &AppHandle<R>, url: &str) {
    let link = match parse(url, SCHEME) {
        Ok(link) => link,
        Err(code) => {
            log::warn!("W_DEEP_LINK_REFUSED {code}");
            return;
        }
    };
    deliver(app, link);
}

pub(crate) fn deliver<R: Runtime>(app: &AppHandle<R>, link: Link) {
    bring_forward(app);
    if let Some(links) = app.try_state::<DeepLinks>() {
        links.update(app, |inbox| inbox.arrive(link));
    }
}

fn bring_forward<R: Runtime>(app: &AppHandle<R>) {
    let window = app
        .get_webview_window(settings::LABEL)
        .or_else(|| app.get_webview_window(MAIN_WINDOW));
    let Some(window) = window else {
        return; // Still starting: the main window shows when it is built.
    };
    if window
        .unminimize()
        .and(window.show())
        .and(window.set_focus())
        .is_err()
    {
        log::warn!("W_DEEP_LINK_FOCUS_FAILED");
    }
}

pub(crate) fn settings_opened<R: Runtime>(app: &AppHandle<R>) {
    if let Some(links) = app.try_state::<DeepLinks>() {
        links.update(app, |inbox| inbox.settings(true));
    }
}

pub(crate) fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != settings::LABEL || !matches!(event, WindowEvent::Destroyed) {
        return;
    }
    let app = window.app_handle();
    if let Some(links) = app.try_state::<DeepLinks>() {
        links.update(app, |inbox| inbox.settings(false));
    }
}

pub(crate) fn on_page_load<R: Runtime>(webview: &tauri::Webview<R>, payload: &PageLoadPayload<'_>) {
    if webview.label() != MAIN_WINDOW || payload.event() != PageLoadEvent::Started {
        return;
    }
    if let Some(links) = webview.try_state::<DeepLinks>() {
        links.with(Inbox::page_started);
    }
}

#[tauri::command]
pub fn deep_link_take(links: tauri::State<'_, DeepLinks>) -> Vec<Link> {
    links.with(Inbox::take)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "01890a5d-ac96-774b-bcce-b302099a8057";

    fn note() -> Link {
        Link::Note { id: ID.to_owned() }
    }

    fn command(id: &'static str) -> Link {
        Link::Command { id }
    }

    #[test]
    fn this_build_answers_to_the_debug_scheme() {
        assert_eq!(SCHEME, "devot-dev");
    }

    #[test]
    fn reads_a_note_link() {
        assert_eq!(parse(&format!("devot://note/{ID}"), "devot"), Ok(note()));
        assert_eq!(
            parse(&format!("devot-dev://note/{ID}"), "devot-dev"),
            Ok(note())
        );
    }

    #[test]
    fn reads_every_allowed_command() {
        for id in URL_COMMANDS {
            assert_eq!(
                parse(&format!("devot://command/{id}"), "devot"),
                Ok(command(id))
            );
        }
    }

    #[test]
    fn refuses_another_scheme() {
        let url = format!("devot://note/{ID}");
        assert_eq!(parse(&url, "devot-dev"), Err("E_URL_SCHEME"));
        let dev = format!("devot-dev://note/{ID}");
        assert_eq!(parse(&dev, "devot"), Err("E_URL_SCHEME"));
        for url in [
            format!("DEVOT://note/{ID}"),
            format!("devot:note/{ID}"),
            format!("devot:/note/{ID}"),
            format!("https://note/{ID}"),
            format!(" devot://note/{ID}"),
        ] {
            assert_eq!(parse(&url, "devot"), Err("E_URL_SCHEME"), "{url}");
        }
    }

    #[test]
    fn refuses_note_ids_that_are_not_canonical_uuidv7() {
        for id in [
            "",
            "not-an-id",
            "9b2e4c1a-6f3d-4e8a-9c7b-1d2e3f4a5b6c",
            "01890A5D-AC96-774B-BCCE-B302099A8057",
            "{01890a5d-ac96-774b-bcce-b302099a8057}",
            "01890a5dac96774bbcceb302099a8057",
        ] {
            assert_eq!(
                parse(&format!("devot://note/{id}"), "devot"),
                Err("E_URL_NOTE_ID"),
                "{id}"
            );
        }
    }

    #[test]
    fn refuses_anything_after_the_id() {
        for tail in ["/", "/x", "?a=b", "#top", "%20", "/.."] {
            let url = format!("devot://note/{ID}{tail}");
            assert_eq!(parse(&url, "devot"), Err("E_URL_NOTE_ID"), "{url}");
            let url = format!("devot://command/view.trash{tail}");
            assert_eq!(parse(&url, "devot"), Err("E_URL_COMMAND"), "{url}");
        }
    }

    #[test]
    fn refuses_commands_not_on_the_list() {
        for id in [
            "",
            "note.new",
            "note.trash",
            "trash.empty",
            "note.copyLink",
            "app.exportAllMarkdown",
            "Note.New",
            "view.trash ",
            "view%2Etrash",
        ] {
            assert_eq!(
                parse(&format!("devot://command/{id}"), "devot"),
                Err("E_URL_COMMAND"),
                "{id}"
            );
        }
    }

    #[test]
    fn refuses_other_hosts_and_shapes() {
        assert_eq!(parse("devot://file/abc", "devot"), Err("E_URL_HOST"));
        assert_eq!(
            parse(&format!("devot://NOTE/{ID}"), "devot"),
            Err("E_URL_HOST")
        );
        assert_eq!(
            parse(&format!("devot://user@note/{ID}"), "devot"),
            Err("E_URL_HOST")
        );
        assert_eq!(
            parse(&format!("devot://note:80/{ID}"), "devot"),
            Err("E_URL_HOST")
        );
        assert_eq!(
            parse(&format!("devot:///note/{ID}"), "devot"),
            Err("E_URL_HOST")
        );
        assert_eq!(parse("devot://note", "devot"), Err("E_URL_PATH"));
        assert_eq!(parse("devot://", "devot"), Err("E_URL_PATH"));
        let long = format!("devot://note/{}", "a".repeat(MAX_URL_LEN));
        assert_eq!(parse(&long, "devot"), Err("E_URL_TOO_LONG"));
    }

    #[test]
    fn the_longest_accepted_url_fits_the_limit() {
        let longest = URL_COMMANDS
            .iter()
            .map(|c| c.len())
            .max()
            .unwrap_or(0)
            .max(ID.len());
        assert!(format!("{DEBUG_SCHEME}://command/").len() + longest <= MAX_URL_LEN);
    }

    #[test]
    fn holds_links_until_the_window_asks_for_them() {
        let mut inbox = Inbox::default();
        assert!(inbox.arrive(note()).is_empty());
        assert!(inbox.arrive(command("view.trash")).is_empty());
        assert_eq!(inbox.take(), vec![note(), command("view.trash")]);
        assert_eq!(
            inbox.arrive(command("view.edit")),
            vec![command("view.edit")]
        );
        assert!(inbox.take().is_empty());
    }

    #[test]
    fn holds_links_while_settings_is_open() {
        let mut inbox = Inbox::default();
        assert!(inbox.take().is_empty());
        assert!(inbox.settings(true).is_empty());
        assert!(inbox.arrive(note()).is_empty());
        assert!(inbox.arrive(command("view.focus")).is_empty());
        assert_eq!(inbox.settings(false), vec![note(), command("view.focus")]);
        assert!(inbox.release().is_empty());
    }

    #[test]
    fn a_window_asking_while_settings_is_open_gets_its_links_when_it_closes() {
        let mut inbox = Inbox::default();
        inbox.settings(true);
        inbox.arrive(note());
        assert!(inbox.take().is_empty());
        assert_eq!(inbox.settings(false), vec![note()]);
    }

    #[test]
    fn closing_settings_before_the_window_is_ready_delivers_nothing() {
        let mut inbox = Inbox::default();
        inbox.settings(true);
        inbox.arrive(note());
        assert!(inbox.settings(false).is_empty());
        assert_eq!(inbox.take(), vec![note()]);
    }

    #[test]
    fn a_reloading_page_gets_the_links_that_came_meanwhile_when_it_asks() {
        let mut inbox = Inbox::default();
        assert!(inbox.take().is_empty());
        inbox.page_started();
        assert!(inbox.arrive(note()).is_empty());
        assert_eq!(inbox.take(), vec![note()]);
    }

    #[test]
    fn holds_a_bounded_number_of_links() {
        let mut inbox = Inbox::default();
        for _ in 0..MAX_HELD + 5 {
            inbox.arrive(note());
        }
        assert_eq!(inbox.take().len(), MAX_HELD);
    }

    #[test]
    fn a_link_reaches_the_page_as_kind_and_id() {
        assert_eq!(
            serde_json::to_value(note()).unwrap(),
            serde_json::json!({ "kind": "note", "id": ID })
        );
        assert_eq!(
            serde_json::to_value(command("view.split")).unwrap(),
            serde_json::json!({ "kind": "command", "id": "view.split" })
        );
    }
}
