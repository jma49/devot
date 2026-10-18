//! The app's URL scheme, registered with macOS through the bundle's
//! Info.plist (`plugins.deep-link` in tauri.conf.json): another app opening
//! `devot://note/<id>` brings Devot forward (launching it if needed) and opens
//! the note; `devot://command/<id>` runs one of [`URL_COMMANDS`], a few
//! commands that only show something. Debug builds answer to `devot-dev://`
//! instead ([`SCHEME`], `tauri.debug.conf.json`), so a development bundle
//! never takes the links meant for an installed Devot.
//!
//! Every URL is checked here, whole, before the page sees anything of it:
//! the page gets a [`Link`] (a note ID in canonical UUIDv7 form, or a
//! command from the list), never the URL. A URL refused is logged by its
//! code alone (`W_DEEP_LINK_REFUSED`), never its text.
//!
//! The same scheme also names attachments inside the window
//! (`devot://file/<id>`, `register_asynchronous_uri_scheme_protocol` in
//! lib.rs). That protocol lives in the web view alone; this module refuses
//! such a URL if another app sends one.
//!
//! Links wait in an [`Inbox`] until the main window has started and asked for
//! them (`deep_link_take`), and while the Settings window is open: they are
//! delivered, in order, once it has closed. Sheets inside the main window
//! hold links back in the page itself (`deepLink.ts`).
//!
//! A second launch of the app (its binary started again, with a URL among its
//! arguments or none) does not open the data folder: the single-instance
//! plugin hands its arguments to this process ([`on_second_instance`]) and
//! ends it.

use std::collections::VecDeque;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, Window, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;

use crate::commands::notes::valid_note_id;
use crate::{MAIN_WINDOW, settings};

/// The scheme of a release build.
pub(crate) const RELEASE_SCHEME: &str = "devot";
/// The scheme of a debug build (`pnpm build:debug`, `pnpm dev`, tests).
pub(crate) const DEBUG_SCHEME: &str = "devot-dev";
/// The scheme this build answers to.
pub(crate) const SCHEME: &str = if cfg!(debug_assertions) {
    DEBUG_SCHEME
} else {
    RELEASE_SCHEME
};

/// The commands a URL may run: each one only shows something (a view, a
/// mode, a dialog, the palette) or makes an empty note. Nothing that
/// trashes, deletes, moves, imports, exports, edits or writes the clipboard.
/// `deepLink.ts` lists the same (a test compares them).
pub(crate) const URL_COMMANDS: &[&str] = &[
    "note.new",
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
/// The most URLs taken from one event or one second launch.
const MAX_PER_EVENT: usize = 4;
/// The most links held while the window cannot take them; later ones are dropped.
const MAX_HELD: usize = 16;
/// The event that brings a link to the main window.
pub(crate) const EVENT: &str = "devot://open-url";

/// What a URL asks for, checked.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Link {
    /// Open the note with this ID.
    Note { id: String },
    /// Run this command (one of [`URL_COMMANDS`]).
    Command { id: &'static str },
}

/// Reads `url` as `<scheme>://note/<id>` or `<scheme>://command/<id>`, exactly:
/// no query, fragment, escapes, trailing slash or other case. Returns the
/// code of the refusal otherwise.
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

/// Links on their way to the main window.
#[derive(Debug, Default)]
pub(crate) struct Inbox {
    /// The window has asked for the links (it listens from then on).
    ready: bool,
    held: VecDeque<Link>,
}

impl Inbox {
    /// A link has come: the links to deliver now, in order (none while the
    /// window is not ready or Settings is open: the link is held then).
    fn arrive(&mut self, link: Link, settings_open: bool) -> Vec<Link> {
        if self.held.len() < MAX_HELD {
            self.held.push_back(link);
        } else {
            log::warn!("W_DEEP_LINK_DROPPED");
        }
        self.release(settings_open)
    }

    /// The window asks for the links held; it is ready from now on.
    fn take(&mut self, settings_open: bool) -> Vec<Link> {
        self.ready = true;
        self.release(settings_open)
    }

    /// The links held, when they can be delivered now.
    fn release(&mut self, settings_open: bool) -> Vec<Link> {
        if !self.ready || settings_open {
            return Vec::new();
        }
        self.held.drain(..).collect()
    }
}

/// The app's [`Inbox`] (managed).
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

/// Another launch of the app handed over its arguments and ended: each URL of
/// this build's scheme among them is taken; Devot comes forward either way.
pub(crate) fn on_second_instance<R: Runtime>(app: &AppHandle<R>, args: Vec<String>, _cwd: String) {
    let prefix = format!("{SCHEME}:");
    let urls: Vec<&String> = args
        .iter()
        .skip(1)
        .filter(|arg| arg.starts_with(&prefix))
        .take(MAX_PER_EVENT)
        .collect();
    if urls.is_empty() {
        bring_forward(app);
    }
    for url in urls {
        receive(app, url);
    }
}

/// Checks a URL and passes its link on, bringing Devot forward.
fn receive<R: Runtime>(app: &AppHandle<R>, url: &str) {
    let link = match parse(url, SCHEME) {
        Ok(link) => link,
        Err(code) => {
            log::warn!("W_DEEP_LINK_REFUSED {code}");
            return;
        }
    };
    bring_forward(app);
    let open = settings_open(app);
    let now = app
        .state::<DeepLinks>()
        .with(|inbox| inbox.arrive(link, open));
    deliver(app, now);
}

/// Whether the Settings window is open (links wait until it closes).
fn settings_open<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window(settings::LABEL).is_some()
}

/// Shows the window the user should see: Settings while it is open,
/// otherwise the main window.
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

fn deliver<R: Runtime>(app: &AppHandle<R>, links: Vec<Link>) {
    for link in links {
        if app.emit_to(MAIN_WINDOW, EVENT, &link).is_err() {
            log::warn!("W_DEEP_LINK_EMIT_FAILED");
        }
    }
}

/// Delivers the links held while Settings was open, once it has closed.
pub(crate) fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != settings::LABEL || !matches!(event, WindowEvent::Destroyed) {
        return;
    }
    let app = window.app_handle();
    let Some(links) = app.try_state::<DeepLinks>() else {
        return;
    };
    let now = links.with(|inbox| inbox.release(false));
    deliver(app, now);
}

/// The main window has started (its last view restored) and listens for
/// links from now on: the links held for it.
#[tauri::command]
pub fn deep_link_take(app: AppHandle, links: tauri::State<'_, DeepLinks>) -> Vec<Link> {
    let open = settings_open(&app);
    links.with(|inbox| inbox.take(open))
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
        // Test builds are debug builds, like `pnpm dev` and debug bundles.
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
            // A v4 UUID.
            "9b2e4c1a-6f3d-4e8a-9c7b-1d2e3f4a5b6c",
            // Upper case, braces, no hyphens.
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
            let url = format!("devot://command/note.new{tail}");
            assert_eq!(parse(&url, "devot"), Err("E_URL_COMMAND"), "{url}");
        }
    }

    #[test]
    fn refuses_commands_not_on_the_list() {
        for id in [
            "",
            "note.trash",
            "trash.empty",
            "note.copyLink",
            "app.exportAllMarkdown",
            "Note.New",
            "note.new ",
            "note%2Enew",
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
        assert!(inbox.arrive(note(), false).is_empty());
        assert!(inbox.arrive(command("view.trash"), false).is_empty());
        assert_eq!(inbox.take(false), vec![note(), command("view.trash")]);
        // From then on a link goes straight through.
        assert_eq!(
            inbox.arrive(command("note.new"), false),
            vec![command("note.new")]
        );
        assert!(inbox.take(false).is_empty());
    }

    #[test]
    fn holds_links_while_settings_is_open() {
        let mut inbox = Inbox::default();
        assert!(inbox.take(false).is_empty());
        assert!(inbox.arrive(note(), true).is_empty());
        assert!(inbox.arrive(command("view.focus"), true).is_empty());
        // Settings closed: delivered in order, once.
        assert_eq!(inbox.release(false), vec![note(), command("view.focus")]);
        assert!(inbox.release(false).is_empty());
    }

    #[test]
    fn a_window_asking_while_settings_is_open_gets_its_links_when_it_closes() {
        let mut inbox = Inbox::default();
        inbox.arrive(note(), false);
        assert!(inbox.take(true).is_empty());
        assert_eq!(inbox.release(false), vec![note()]);
    }

    #[test]
    fn closing_settings_before_the_window_is_ready_delivers_nothing() {
        let mut inbox = Inbox::default();
        inbox.arrive(note(), true);
        assert!(inbox.release(false).is_empty());
        assert_eq!(inbox.take(false), vec![note()]);
    }

    #[test]
    fn holds_a_bounded_number_of_links() {
        let mut inbox = Inbox::default();
        for _ in 0..MAX_HELD + 5 {
            inbox.arrive(note(), false);
        }
        assert_eq!(inbox.take(false).len(), MAX_HELD);
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
