//! The app's URL scheme, registered with macOS through the bundle's Info.plist (`plugins.deep-link`
//! in tauri.conf.json): `devot://note/<id>` opens the note, `devot://command/<id>` runs one of
//! [`URL_COMMANDS`] and `devot://licence?key=<key>` offers a licence key, checked here first; the
//! window asks before it replaces a licence the device holds. Debug builds answer to `devot-dev://` instead ([`SCHEME`]), so a development
//! bundle never takes the links meant for an installed Devot.
//! Every URL is checked here, whole, before the page sees anything of it: the page gets a [`Link`],
//! never the URL. A refused URL is logged by its code alone (`W_DEEP_LINK_REFUSED`), never its
//! text.
//! `devot://file/<id>` names attachments inside the window
//! (`register_asynchronous_uri_scheme_protocol` in lib.rs); that protocol lives in the web view
//! alone and this module refuses such a URL from another app.
//! Links wait in an [`Inbox`] until a main window has asked for them (`deep_link_take`; again
//! after a reload) and while the Settings window is open. They go to the frontmost main window that
//! has asked (`main_windows`). A second launch does not open the data
//! folder: the single-instance plugin hands its arguments to this process ([`on_second_instance`])
//! and ends it. The `devot` command hands files over the same way (`cli`).

use std::collections::{BTreeSet, VecDeque};
use std::sync::Mutex;

use serde::Serialize;
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Emitter, Manager, Runtime, Window, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;

use crate::commands::notes::valid_note_id;
use crate::main_windows::{self, is_main};
use crate::settings;

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

/// Longer than any URL accepted (`devot-dev://note/` and an ID is 53) but a licence link.
const MAX_URL_LEN: usize = 96;
/// A licence key, every character of it percent-encoded, after `devot-dev://licence?key=`.
const MAX_LICENCE_URL_LEN: usize = 32 + 3 * crate::licence::MAX_LENGTH;
const MAX_PER_EVENT: usize = 4;
const MAX_HELD: usize = 16;
/// Files handed over by the `devot` command, apart from URLs: they come only over the user's own
/// socket, and a hand-off past this is refused, so the command fails rather than lose them.
const MAX_HELD_IMPORTS: usize = 64;
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
    /// A key that verified comes with what it is (`offer`); one that did not, with its code alone.
    Licence {
        key: Option<LicenceKey>,
        offer: Option<crate::licence::Offer>,
        code: Option<&'static str>,
    },
}

impl Link {
    fn is_import(&self) -> bool {
        matches!(self, Self::Import { .. })
    }
}

/// `Debug` never shows the key: it holds the licensee's address.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct LicenceKey(String);

impl std::fmt::Debug for LicenceKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("LicenceKey(..)")
    }
}

fn key_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_')
}

/// `key=<key>` and nothing else; a character of the key may be percent-encoded.
fn licence_link(query: &str) -> Result<Link, &'static str> {
    let value = query.strip_prefix("key=").ok_or("E_URL_LICENCE")?;
    let bytes = value.as_bytes();
    let mut key = String::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let byte = if bytes[at] == b'%' {
            let hex = value.get(at + 1..at + 3).ok_or("E_URL_LICENCE")?;
            at += 3;
            u8::from_str_radix(hex, 16).map_err(|_| "E_URL_LICENCE")?
        } else {
            at += 1;
            bytes[at - 1]
        };
        if !key_char(byte) {
            return Err("E_URL_LICENCE");
        }
        key.push(char::from(byte));
    }
    if key.is_empty() || key.len() > crate::licence::MAX_LENGTH {
        return Err("E_URL_LICENCE");
    }
    Ok(Link::Licence {
        key: Some(LicenceKey(key)),
        offer: None,
        code: None,
    })
}

/// Exact: no query (but a licence link's one `key`), fragment, escapes (but in that key), trailing
/// slash or other case. Returns the code of the refusal otherwise.
pub(crate) fn parse(url: &str, scheme: &str) -> Result<Link, &'static str> {
    let rest = url
        .strip_prefix(scheme)
        .and_then(|rest| rest.strip_prefix("://"));
    if let Some(query) = rest.and_then(|rest| rest.strip_prefix("licence?")) {
        if url.len() > MAX_LICENCE_URL_LEN {
            return Err("E_URL_TOO_LONG");
        }
        return licence_link(query);
    }
    if url.len() > MAX_URL_LEN {
        return Err("E_URL_TOO_LONG");
    }
    let rest = rest.ok_or("E_URL_SCHEME")?;
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
    /// The main windows that have asked for the links (they listen from then on) and have not
    /// reloaded since.
    ready: BTreeSet<String>,
    settings_open: bool,
    held: VecDeque<Link>,
}

impl Inbox {
    fn room_for_import(&self) -> bool {
        self.held.iter().filter(|link| link.is_import()).count() < MAX_HELD_IMPORTS
    }

    fn room_for(&self, link: &Link) -> bool {
        if link.is_import() {
            return self.room_for_import();
        }
        self.held.iter().filter(|link| !link.is_import()).count() < MAX_HELD
    }

    /// The link back when there is no room for it.
    fn offer(&mut self, link: Link) -> Result<Vec<Link>, Box<Link>> {
        if !self.room_for(&link) {
            log::warn!("W_DEEP_LINK_DROPPED");
            return Err(Box::new(link));
        }
        self.held.push_back(link);
        Ok(self.release())
    }

    #[cfg(test)]
    fn arrive(&mut self, link: Link) -> Vec<Link> {
        self.offer(link).unwrap_or_default()
    }

    fn take(&mut self, label: &str) -> Vec<Link> {
        self.ready.insert(label.to_owned());
        self.release()
    }

    fn page_started(&mut self, label: &str) {
        self.ready.remove(label);
    }

    fn gone(&mut self, label: &str) {
        self.ready.remove(label);
    }

    fn settings(&mut self, open: bool) -> Vec<Link> {
        self.settings_open = open;
        self.release()
    }

    fn release(&mut self) -> Vec<Link> {
        if self.ready.is_empty() || self.settings_open {
            return Vec::new();
        }
        self.held.drain(..).collect()
    }

    /// Where released links go: the frontmost main window when it has asked, else the first that has.
    fn target(&self, front: Option<&str>) -> Option<String> {
        front
            .filter(|label| self.ready.contains(*label))
            .map(str::to_owned)
            .or_else(|| self.ready.iter().next().cloned())
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

    fn update<R: Runtime>(&self, app: &AppHandle<R>, f: impl FnOnce(&mut Inbox) -> Vec<Link>) {
        self.update_with(
            || main_windows::front_label(app),
            f,
            |target, link| {
                if app.emit_to(target, EVENT, link).is_err() {
                    log::warn!("W_DEEP_LINK_EMIT_FAILED");
                }
            },
        );
    }

    /// Changes the inbox and sends what it releases, under its lock, so links
    /// reach the page in the order they came, whatever thread they came on.
    /// The front window is asked for first: off the main thread its getters
    /// wait for the main thread, which may be waiting for this lock.
    fn update_with(
        &self,
        front: impl FnOnce() -> Option<String>,
        f: impl FnOnce(&mut Inbox) -> Vec<Link>,
        mut send: impl FnMut(&str, &Link),
    ) {
        let front = front();
        self.with(|inbox| {
            let links = f(inbox);
            if links.is_empty() {
                return;
            }
            let Some(target) = inbox.target(front.as_deref()) else {
                return;
            };
            for link in &links {
                send(&target, link);
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
        Ok(Link::Licence { key: Some(key), .. }) => checked(
            key,
            app.try_state::<std::sync::Arc<crate::licence::Licence>>()
                .as_deref()
                .map(AsRef::as_ref),
        ),
        Ok(link) => link,
        Err(code) => {
            log::warn!("W_DEEP_LINK_REFUSED {code}");
            return;
        }
    };
    deliver(app, link);
}

/// A key that does not verify reaches the window as its code, so it can say why.
fn checked(key: LicenceKey, licence: Option<&crate::licence::Licence>) -> Link {
    let offer = licence
        .ok_or("E_LICENCE_INTERNAL")
        .and_then(|licence| licence.offer(&key.0));
    match offer {
        Ok(offer) => Link::Licence {
            key: Some(key),
            offer: Some(offer),
            code: None,
        },
        Err(code) => {
            log::warn!("W_DEEP_LINK_LICENCE_REFUSED {code}");
            Link::Licence {
                key: None,
                offer: None,
                code: Some(code),
            }
        }
    }
}

pub(crate) fn deliver<R: Runtime>(app: &AppHandle<R>, link: Link) {
    bring_forward(app);
    let Some(links) = app.try_state::<DeepLinks>() else {
        return;
    };
    let mut dropped = None;
    links.update(app, |inbox| {
        inbox.offer(link).unwrap_or_else(|link| {
            dropped = Some(*link);
            Vec::new()
        })
    });
    if let Some(Link::Import { scan, .. }) = dropped
        && let Some(imports) = app.try_state::<crate::import::Imports>()
    {
        imports.finish(scan.id);
    }
}

/// Whether files handed over now would be held: the single-instance listener refuses the hand-off
/// otherwise, so the `devot` command fails instead of losing them.
pub(crate) fn room_for_import<R: Runtime>(app: &AppHandle<R>) -> bool {
    let open = app
        .try_state::<crate::import::Imports>()
        .map_or(0, |imports| imports.open());
    app.try_state::<DeepLinks>()
        .is_none_or(|links| links.with(|inbox| import_room(inbox, open)))
}

/// Files released to the page wait in its queue, which holds as many as Rust does and is not seen
/// from here; every one of them is an import not yet finished, so those are counted instead.
fn import_room(inbox: &Inbox, open_imports: usize) -> bool {
    inbox.room_for_import() && open_imports < MAX_HELD_IMPORTS
}

/// A phone has no minimized windows.
pub(crate) fn unminimize<R: Runtime>(window: &tauri::WebviewWindow<R>) -> tauri::Result<()> {
    #[cfg(desktop)]
    return window.unminimize();
    #[cfg(mobile)]
    {
        let _ = window;
        Ok(())
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Forward {
    show_main: bool,
    focus: Option<String>,
}

/// Settings holds links until it closes (`Inbox::settings`), and they then land in the frontmost main
/// window, so a main window hidden in menu bar mode shows behind it. `front` is that window's label
/// and whether it is visible.
fn forward(settings_open: bool, front: Option<(&str, bool)>) -> Forward {
    let focus = if settings_open {
        Some(settings::LABEL.to_owned())
    } else {
        front.map(|(label, _)| label.to_owned())
    };
    Forward {
        show_main: settings_open && matches!(front, Some((_, false))),
        focus,
    }
}

fn bring_forward<R: Runtime>(app: &AppHandle<R>) {
    let main = main_windows::front_label(app).and_then(|label| app.get_webview_window(&label));
    let visible = main.as_ref().map(|main| main.is_visible().unwrap_or(true));
    let plan = forward(
        app.get_webview_window(settings::LABEL).is_some(),
        main.as_ref()
            .zip(visible)
            .map(|(main, visible)| (main.label(), visible)),
    );
    if plan.show_main
        && let Some(main) = &main
        && main.show().is_err()
    {
        log::warn!("W_DEEP_LINK_FOCUS_FAILED");
    }
    // Still starting when there is no window: the main window shows when it is built.
    let Some(window) = plan.focus.and_then(|label| app.get_webview_window(&label)) else {
        return;
    };
    if unminimize(&window)
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
    if !matches!(event, WindowEvent::Destroyed) {
        return;
    }
    let app = window.app_handle();
    let Some(links) = app.try_state::<DeepLinks>() else {
        return;
    };
    if window.label() == settings::LABEL {
        links.update(app, |inbox| inbox.settings(false));
    } else if is_main(window.label()) {
        links.with(|inbox| inbox.gone(window.label()));
    }
}

pub(crate) fn on_page_load<R: Runtime>(webview: &tauri::Webview<R>, payload: &PageLoadPayload<'_>) {
    if !is_main(webview.label()) || payload.event() != PageLoadEvent::Started {
        return;
    }
    if let Some(links) = webview.try_state::<DeepLinks>() {
        links.with(|inbox| inbox.page_started(webview.label()));
    }
}

#[tauri::command]
pub fn deep_link_take(
    links: tauri::State<'_, DeepLinks>,
    window: tauri::WebviewWindow,
) -> Vec<Link> {
    links.with(|inbox| inbox.take(window.label()))
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
    fn a_link_brings_the_settings_window_forward_and_shows_a_hidden_main_window_behind_it() {
        assert_eq!(
            forward(true, Some(("main", false))),
            Forward {
                show_main: true,
                focus: Some(settings::LABEL.into())
            }
        );
        assert_eq!(
            forward(true, Some(("main", true))),
            Forward {
                show_main: false,
                focus: Some(settings::LABEL.into())
            }
        );
    }

    #[test]
    fn without_settings_a_link_brings_the_frontmost_main_window_forward() {
        for visible in [true, false] {
            assert_eq!(
                forward(false, Some(("main", visible))),
                Forward {
                    show_main: false,
                    focus: Some("main".into())
                }
            );
        }
        assert_eq!(
            forward(false, Some(("main-3", true))),
            Forward {
                show_main: false,
                focus: Some("main-3".into())
            }
        );
        assert_eq!(
            forward(false, None),
            Forward {
                show_main: false,
                focus: None
            }
        );
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

    fn licence(key: &str) -> Link {
        Link::Licence {
            key: Some(LicenceKey(key.to_owned())),
            offer: None,
            code: None,
        }
    }

    #[test]
    fn a_licence_link_reaches_the_window_as_its_offer_or_as_its_code_alone() {
        use crate::licence::testing::{ID, LICENSEE, key};
        let dir = tempfile::tempdir().expect("dir");
        let service = crate::licence::testing::licence(dir.path(), true);
        let good = key(ID);

        let Link::Licence {
            key: kept,
            offer,
            code,
        } = checked(LicenceKey(good.clone()), Some(&service))
        else {
            panic!("not a licence link");
        };
        assert_eq!(kept, Some(LicenceKey(good)));
        let offer = offer.expect("offer");
        assert_eq!((offer.id.as_str(), offer.licensee.as_str()), (ID, LICENSEE));
        assert_eq!(code, None);

        let malformed = format!("{}.x", key(ID));
        for (licence, want) in [
            (Some(&*service), "E_LICENCE_MALFORMED"),
            (None, "E_LICENCE_INTERNAL"),
        ] {
            assert_eq!(
                checked(LicenceKey(malformed.clone()), licence),
                Link::Licence {
                    key: None,
                    offer: None,
                    code: Some(want),
                }
            );
        }
    }

    #[test]
    fn reads_a_licence_link_whole_or_percent_encoded() {
        let key = crate::licence::testing::key(crate::licence::testing::ID);
        assert_eq!(
            parse(&format!("devot://licence?key={key}"), "devot"),
            Ok(licence(&key))
        );
        assert_eq!(
            parse(&format!("devot-dev://licence?key={key}"), "devot-dev"),
            Ok(licence(&key))
        );
        let encoded: String = key.bytes().map(|b| format!("%{b:02X}")).collect();
        assert_eq!(
            parse(&format!("devot://licence?key={encoded}"), "devot"),
            Ok(licence(&key))
        );
        let mixed = key.replacen('.', "%2e", 2);
        assert_eq!(
            parse(&format!("devot://licence?key={mixed}"), "devot"),
            Ok(licence(&key))
        );
    }

    #[test]
    fn refuses_a_licence_link_with_anything_else_in_it() {
        let key = crate::licence::testing::key(crate::licence::testing::ID);
        for url in [
            format!("devot://licence?key={key}&x=1"),
            format!("devot://licence?key={key}#x"),
            format!("devot://licence?x=1&key={key}"),
            format!("devot://licence?key={key}%"),
            format!("devot://licence?key={key}%2"),
            format!("devot://licence?key={key}%zz"),
            format!("devot://licence?key={key}%20"),
            format!("devot://licence?key={key}+"),
            format!("devot://licence?key={key}="),
            format!("devot://licence?key= {key}"),
            "devot://licence?key=".to_owned(),
            "devot://licence?".to_owned(),
            format!(
                "devot://licence?key={}",
                "a".repeat(crate::licence::MAX_LENGTH + 1)
            ),
        ] {
            assert_eq!(parse(&url, "devot"), Err("E_URL_LICENCE"), "{url}");
        }
        let long = format!(
            "devot://licence?key={}",
            "%41".repeat(crate::licence::MAX_LENGTH + 10)
        );
        assert_eq!(parse(&long, "devot"), Err("E_URL_TOO_LONG"));
        assert_eq!(
            parse(&format!("devot://licence/?key={key}"), "devot"),
            Err("E_URL_TOO_LONG")
        );
        assert_eq!(
            parse(&format!("devot-dev://licence?key={key}"), "devot"),
            Err("E_URL_TOO_LONG")
        );
    }

    #[test]
    fn a_licence_link_never_shows_its_key_when_debugged() {
        let key = crate::licence::testing::key(crate::licence::testing::ID);
        let shown = format!("{:?}", licence(&key));
        assert!(!shown.contains(&key[7..40]), "{shown}");
        let sent = serde_json::to_value(licence(&key)).unwrap();
        assert_eq!(sent["kind"], "licence");
        assert_eq!(sent["key"], key.as_str());
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
        assert_eq!(inbox.take("main"), vec![note(), command("view.trash")]);
        assert_eq!(
            inbox.arrive(command("view.edit")),
            vec![command("view.edit")]
        );
        assert!(inbox.take("main").is_empty());
    }

    #[test]
    fn holds_links_while_settings_is_open() {
        let mut inbox = Inbox::default();
        assert!(inbox.take("main").is_empty());
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
        assert!(inbox.take("main").is_empty());
        assert_eq!(inbox.settings(false), vec![note()]);
    }

    #[test]
    fn closing_settings_before_the_window_is_ready_delivers_nothing() {
        let mut inbox = Inbox::default();
        inbox.settings(true);
        inbox.arrive(note());
        assert!(inbox.settings(false).is_empty());
        assert_eq!(inbox.take("main"), vec![note()]);
    }

    #[test]
    fn a_reloading_page_gets_the_links_that_came_meanwhile_when_it_asks() {
        let mut inbox = Inbox::default();
        assert!(inbox.take("main").is_empty());
        inbox.page_started("main");
        assert!(inbox.arrive(note()).is_empty());
        assert_eq!(inbox.take("main"), vec![note()]);
    }

    // Off the main thread, a window's getters wait for the main thread, which may be waiting for
    // this lock (a page asking for its links).
    #[test]
    fn asks_which_window_is_in_front_without_holding_the_inbox() {
        let links = DeepLinks::default();
        links.with(|inbox| inbox.take("main"));
        let mut sent = Vec::new();
        links.update_with(
            || {
                assert!(links.0.try_lock().is_ok(), "the inbox is locked");
                Some("main".to_owned())
            },
            |inbox| inbox.arrive(note()),
            |target, link| sent.push((target.to_owned(), link.clone())),
        );
        assert_eq!(sent, vec![("main".to_owned(), note())]);
    }

    #[test]
    fn holds_a_bounded_number_of_links() {
        let mut inbox = Inbox::default();
        for _ in 0..MAX_HELD + 5 {
            inbox.arrive(note());
        }
        assert_eq!(inbox.take("main").len(), MAX_HELD);
    }

    fn import(id: u64) -> Link {
        Link::Import {
            scan: crate::import::Scan {
                id,
                name: String::new(),
                kind: crate::import::Kind::Files,
                files: Vec::new(),
                images: Vec::new(),
                skipped: Vec::new(),
                destination: None,
            },
            notebook: None,
            first: None,
        }
    }

    #[test]
    fn holds_handed_over_files_apart_from_urls_and_refuses_them_only_when_full() {
        let mut inbox = Inbox::default();
        inbox.settings(true);
        for _ in 0..MAX_HELD + 5 {
            inbox.arrive(note());
        }
        for id in 0..MAX_HELD_IMPORTS as u64 {
            assert!(inbox.room_for_import());
            assert_eq!(inbox.offer(import(id)), Ok(Vec::new()));
        }
        assert!(!inbox.room_for_import());
        assert_eq!(inbox.offer(import(99)), Err(Box::new(import(99))));
        inbox.settings(false);
        let held = inbox.take("main");
        assert_eq!(
            held.iter().filter(|link| link.is_import()).count(),
            MAX_HELD_IMPORTS
        );
        assert_eq!(held.len(), MAX_HELD + MAX_HELD_IMPORTS);
        assert!(inbox.room_for_import());
    }

    #[test]
    fn refuses_files_while_the_page_may_already_hold_as_many_imports_as_it_takes() {
        let mut inbox = Inbox::default();
        inbox.take("main");
        assert!(import_room(&inbox, MAX_HELD_IMPORTS - 1));
        assert!(!import_room(&inbox, MAX_HELD_IMPORTS));
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

    #[test]
    fn links_go_to_the_frontmost_main_window_that_has_asked() {
        let mut inbox = Inbox::default();
        assert_eq!(inbox.target(Some("main")), None);
        inbox.take("main");
        assert_eq!(inbox.target(Some("main-2")).as_deref(), Some("main"));
        inbox.take("main-2");
        assert_eq!(inbox.target(Some("main-2")).as_deref(), Some("main-2"));
        assert_eq!(inbox.target(Some("main")).as_deref(), Some("main"));
        assert_eq!(inbox.target(None).as_deref(), Some("main"));
        assert_eq!(inbox.target(Some("settings")).as_deref(), Some("main"));
    }

    #[test]
    fn a_second_window_asking_gets_what_waits_while_the_first_has_not() {
        let mut inbox = Inbox::default();
        assert!(inbox.arrive(note()).is_empty());
        assert_eq!(inbox.take("main-2"), vec![note()]);
        assert_eq!(
            inbox.arrive(command("view.edit")),
            vec![command("view.edit")]
        );
    }

    #[test]
    fn a_window_that_reloads_or_closes_no_longer_receives_links() {
        let mut inbox = Inbox::default();
        inbox.take("main");
        inbox.take("main-2");
        inbox.page_started("main-2");
        assert_eq!(inbox.target(Some("main-2")).as_deref(), Some("main"));
        inbox.gone("main");
        assert_eq!(inbox.target(Some("main")), None);
        assert!(inbox.arrive(note()).is_empty());
        assert_eq!(inbox.take("main-2"), vec![note()]);
    }
}
