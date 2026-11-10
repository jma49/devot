//! The app's URL scheme, registered with macOS through the bundle's Info.plist (`plugins.deep-link`
//! in tauri.conf.json): `devot://note/<id>` opens the note, `devot://command/<id>` runs one of
//! [`URL_COMMANDS`], `devot://today` opens today's note (made once a day when missing, so a page
//! opening it over and over makes one note) and `devot://licence?key=<key>` offers a licence key, checked here first; the
//! window asks before it replaces a licence the device holds.
//! On the iPhone `devot://pair?…`, the link a pairing's QR code holds, opens Settings > Sync with
//! the link in Join With a Code, joined only once the owner taps Join; elsewhere it is refused.
//! Debug builds answer to `devot-dev://` instead ([`SCHEME`]), so a development
//! bundle never takes the links meant for an installed Devot; on the iPhone, where a development
//! build replaces the installed app, every build answers to `devot://`.
//! Every URL is checked here, whole, before the page sees anything of it: the page gets a [`Link`],
//! never the URL (but a pairing link, checked whole, which Join With a Code reads). A refused URL is logged by its code alone (`W_DEEP_LINK_REFUSED`), never its
//! text.
//! `devot://file/<id>` names attachments inside the window
//! (`register_asynchronous_uri_scheme_protocol` in lib.rs); that protocol lives in the web view
//! alone and this module refuses such a URL from another app.
//! Links wait in an [`Inbox`] until a main window has asked for them (`deep_link_take`; again
//! after a reload) and while the Settings window is open. They go to the frontmost main window that
//! has asked (`main_windows`); on the iPhone, once its native screens are installed, they go to
//! the screens instead, as routes (`screens::route`), and the page never sees one; there the page
//! asks only once it has listed its library, so a link never outruns the first-launch notes. A second launch does not open the data
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
pub(crate) const SCHEME: &str = if cfg!(debug_assertions) && !cfg!(target_os = "ios") {
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
    "view.write",
    "view.edit",
    "view.preview",
    "app.backups",
    "app.checkForUpdates",
];

/// Longer than any URL accepted (`devot-dev://note/` and an ID is 53) but a licence link.
const MAX_URL_LEN: usize = 96;
/// A licence key, every character of it percent-encoded, after `devot-dev://licence?key=`.
const MAX_LICENCE_URL_LEN: usize = 32 + 3 * crate::licence::MAX_LENGTH;
/// As long as Join With a Code reads (`sync::pairing::read`).
const MAX_PAIR_URL_LEN: usize = 4096;
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
    Today,
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
    /// A pairing link, checked whole; the code in it joins nothing until the owner taps Join.
    Pair {
        link: PairingLink,
    },
}

impl Link {
    fn is_import(&self) -> bool {
        matches!(self, Self::Import { .. })
    }
}

/// `Debug` never shows the key: it holds the licensee's address.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(serde::Deserialize))]
#[serde(transparent)]
pub struct LicenceKey(String);

impl LicenceKey {
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for LicenceKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("LicenceKey(..)")
    }
}

/// `Debug` never shows the link: its code opens the vault's key while the pairing lasts.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(serde::Deserialize))]
#[serde(transparent)]
pub struct PairingLink(String);

impl std::fmt::Debug for PairingLink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PairingLink(..)")
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

/// Exact: no query (but a licence link's one `key` and a pairing link's), fragment, escapes (but in
/// those), trailing slash or other case. Returns the code of the refusal otherwise.
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
    if rest.is_some_and(|rest| rest.starts_with("pair?")) {
        if url.len() > MAX_PAIR_URL_LEN {
            return Err("E_URL_TOO_LONG");
        }
        if url.contains('#') || !crate::sync::is_pairing_link(url) {
            return Err("E_URL_PAIR");
        }
        return Ok(Link::Pair {
            link: PairingLink(url.to_owned()),
        });
    }
    if url.len() > MAX_URL_LEN {
        return Err("E_URL_TOO_LONG");
    }
    let rest = rest.ok_or("E_URL_SCHEME")?;
    if rest == "today" {
        return Ok(Link::Today);
    }
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
    /// The iPhone's native screens are installed: they take every link, once a page has listed its
    /// library and asked, and no page takes one.
    screens: bool,
    held: VecDeque<Link>,
}

/// Where released links go.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Target {
    Window(String),
    Screens,
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

    #[cfg(any(target_os = "ios", test))]
    fn screens_ready(&mut self) -> Vec<Link> {
        self.screens = true;
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

    fn destination(&self, front: Option<&str>) -> Option<Target> {
        if self.screens {
            return Some(Target::Screens);
        }
        self.target(front).map(Target::Window)
    }
}

#[derive(Default)]
pub struct DeepLinks(Mutex<Inbox>);

impl DeepLinks {
    fn with<T>(&self, f: impl FnOnce(&mut Inbox) -> T) -> T {
        let mut inbox = crate::locks::lock(&self.0);
        f(&mut inbox)
    }

    fn update<R: Runtime>(&self, app: &AppHandle<R>, f: impl FnOnce(&mut Inbox) -> Vec<Link>) {
        self.update_with(
            || main_windows::front_label(app),
            f,
            |target, link| match target {
                Target::Window(label) => {
                    let sent = app.emit_to(label.as_str(), EVENT, link).is_ok();
                    if !sent {
                        log::warn!("W_DEEP_LINK_EMIT_FAILED");
                    }
                    handed(app, label, link, sent);
                }
                Target::Screens => {
                    to_screens(link);
                    handed(app, "", link, false);
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
        mut send: impl FnMut(&Target, &Link),
    ) {
        let front = front();
        self.with(|inbox| {
            let links = f(inbox);
            if links.is_empty() {
                return;
            }
            let Some(target) = inbox.destination(front.as_deref()) else {
                return;
            };
            for link in &links {
                send(&target, link);
            }
        });
    }

    /// The links held for the page that asks: under the native screens they go there instead and
    /// the page gets none.
    fn take_with(&self, label: &str, mut to_screens: impl FnMut(&Link)) -> Vec<Link> {
        let mut page = Vec::new();
        self.update_with(
            || Some(label.to_owned()),
            |inbox| inbox.take(label),
            |target, link| match target {
                Target::Window(_) => page.push(link.clone()),
                Target::Screens => to_screens(link),
            },
        );
        page
    }
}

/// A link the iPhone's native screens take as a route; one they do nothing with is dropped here.
fn to_screens(link: &Link) {
    #[cfg(target_os = "ios")]
    crate::native::ios::screens_route(link);
    #[cfg(not(target_os = "ios"))]
    let _ = link;
}

/// The iPhone's native screens are installed: the links held go to them, as every later one does,
/// once the page has listed its library (the first-launch notes seeded) and asked for them, so a
/// link to a first-launch note finds it.
#[cfg(target_os = "ios")]
pub(crate) fn screens_installed<R: Runtime>(app: &AppHandle<R>) {
    if let Some(links) = app.try_state::<DeepLinks>() {
        links.update(app, Inbox::screens_ready);
    }
}

/// Follows the URLs macOS opens the app with (`RunEvent::Opened`, through the
/// deep-link plugin), and takes the ones a launch came with: macOS hands those
/// over before `applicationDidFinishLaunching`, so before setup runs and nothing
/// hears them, and the plugin keeps them as its current URLs (#621).
/// It takes the licence so that setup can call it only once the licence exists.
pub(crate) fn listen(app: &tauri::App, licence: &crate::licence::Licence) {
    let handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls().iter().take(MAX_PER_EVENT) {
            receive(&handle, url.as_str());
        }
    });
    for link in launch_links(app.deep_link().get_current(), licence) {
        deliver(app.handle(), link);
    }
}

fn launch_links<E>(
    current: Result<Option<Vec<tauri::Url>>, E>,
    licence: &crate::licence::Licence,
) -> Vec<Link> {
    let current = current.unwrap_or_else(|_| {
        log::warn!("W_DEEP_LINK_LAUNCH_UNREAD");
        None
    });
    current
        .unwrap_or_default()
        .iter()
        .take(MAX_PER_EVENT)
        .filter_map(|url| link_of(url.as_str(), Some(licence)))
        .collect()
}

pub(crate) fn on_second_instance<R: Runtime>(app: &AppHandle<R>, args: Vec<String>, _cwd: String) {
    // The bridge lost a race to start Devot: the one already here serves it, as it is.
    if args.get(1).map(String::as_str) == Some(crate::cli::BACKGROUND_FLAG) {
        return;
    }
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
    let licence = app.try_state::<std::sync::Arc<crate::licence::Licence>>();
    if let Some(link) = link_of(url, licence.as_deref().map(AsRef::as_ref)) {
        deliver(app, link);
    }
}

fn link_of(url: &str, licence: Option<&crate::licence::Licence>) -> Option<Link> {
    match parse(url, SCHEME).and_then(taken_here) {
        Ok(Link::Licence { key: Some(key), .. }) => Some(checked(key, licence)),
        Ok(link) => Some(link),
        Err(code) => {
            log::warn!("W_DEEP_LINK_REFUSED {code}");
            None
        }
    }
}

/// Only the iPhone's Sync page takes a pairing link from outside (#886).
fn taken_here(link: Link) -> Result<Link, &'static str> {
    match link {
        Link::Pair { .. } if !cfg!(target_os = "ios") => Err("E_URL_PAIR_ELSEWHERE"),
        link => Ok(link),
    }
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

/// Files released to `window` belong to it from now on (`import::Imports::own`); ones that never
/// reached it are finished, as no page will.
fn handed<R: Runtime>(app: &AppHandle<R>, window: &str, link: &Link, sent: bool) {
    let Link::Import { scan, .. } = link else {
        return;
    };
    let Some(imports) = app.try_state::<crate::import::Imports>() else {
        return;
    };
    if sent {
        imports.own(scan.id, window);
    } else {
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
    #[cfg(desktop)]
    crate::background::opened(app);
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
    let app = window.app_handle();
    let taken = links.take_with(window.label(), |link| {
        to_screens(link);
        handed(app, "", link, false);
    });
    for link in &taken {
        handed(app, window.label(), link, true);
    }
    taken
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
    fn reads_the_today_link_exactly() {
        assert_eq!(parse("devot://today", "devot"), Ok(Link::Today));
        assert_eq!(
            serde_json::to_value(Link::Today).unwrap(),
            serde_json::json!({ "kind": "today" })
        );
        for refused in [
            "devot://today/",
            "devot://Today",
            "devot://today?x=1",
            "devot://today#x",
        ] {
            assert!(parse(refused, "devot").is_err(), "{refused}");
        }
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

    const PAIR_CODE: &str = "0400E3GN3GHJMC9R7X34TN2VC9MNJTDF";

    #[test]
    fn reads_a_pairing_link_whole() {
        for url in [
            format!("devot://pair?relay=https%3A%2F%2Frelay.example.com&code={PAIR_CODE}"),
            format!("devot://pair?relay=http%3A%2F%2Flocalhost%3A8787&code={PAIR_CODE}"),
            format!("devot://pair?via=icloud&code={PAIR_CODE}"),
        ] {
            assert_eq!(
                parse(&url, "devot"),
                Ok(Link::Pair {
                    link: PairingLink(url.clone())
                }),
                "{url}"
            );
        }
    }

    #[test]
    fn refuses_a_pairing_link_that_join_would_not_take() {
        let wrong = PAIR_CODE.replace("0400", "0401");
        for url in [
            format!("devot://pair?relay=http%3A%2F%2Frelay.example.com&code={PAIR_CODE}"),
            format!("devot://pair?code={PAIR_CODE}"),
            "devot://pair?relay=https%3A%2F%2Frelay.example.com".to_owned(),
            format!("devot://pair?relay=https%3A%2F%2Frelay.example.com&code={wrong}"),
            format!("devot://pair?relay=https%3A%2F%2Frelay.example.com&code={PAIR_CODE}&x=1"),
            format!("devot://pair?relay=https%3A%2F%2Frelay.example.com&code={PAIR_CODE}#x"),
        ] {
            assert_eq!(parse(&url, "devot"), Err("E_URL_PAIR"), "{url}");
        }
        let long = format!(
            "devot://pair?relay=https%3A%2F%2Frelay.example.com%2F{}&code={PAIR_CODE}",
            "a".repeat(MAX_PAIR_URL_LEN)
        );
        assert_eq!(parse(&long, "devot"), Err("E_URL_TOO_LONG"));
        assert_eq!(
            parse(
                &format!("devot-dev://pair?via=icloud&code={PAIR_CODE}"),
                "devot-dev"
            ),
            Err("E_URL_PAIR")
        );
    }

    #[test]
    fn a_pairing_link_reaches_only_the_iphone() {
        let pair = Link::Pair {
            link: PairingLink(format!("devot://pair?via=icloud&code={PAIR_CODE}")),
        };
        let taken = if cfg!(target_os = "ios") {
            Ok(pair.clone())
        } else {
            Err("E_URL_PAIR_ELSEWHERE")
        };
        assert_eq!(taken_here(pair), taken);
        assert_eq!(taken_here(Link::Today), Ok(Link::Today));
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

    fn launched_with(urls: &[String]) -> Result<Option<Vec<tauri::Url>>, ()> {
        Ok(Some(
            urls.iter()
                .map(|url| tauri::Url::parse(url).unwrap())
                .collect(),
        ))
    }

    #[test]
    fn a_note_link_the_app_was_launched_with_waits_for_the_window_that_asks_first() {
        let dir = tempfile::tempdir().expect("dir");
        let service = crate::licence::testing::licence(dir.path(), true);
        let mut inbox = Inbox::default();
        for link in launch_links(launched_with(&[format!("{SCHEME}://note/{ID}")]), &service) {
            assert!(inbox.arrive(link).is_empty());
        }
        assert_eq!(inbox.take("main"), vec![note()]);
    }

    #[test]
    fn a_licence_link_the_app_was_launched_with_is_checked_against_the_licence() {
        use crate::licence::testing::{ID as LICENCE_ID, key};
        let dir = tempfile::tempdir().expect("dir");
        let service = crate::licence::testing::licence(dir.path(), true);
        let url = format!("{SCHEME}://licence?key={}", key(LICENCE_ID));
        let links = launch_links(launched_with(&[url]), &service);
        let [Link::Licence { offer, code, .. }] = links.as_slice() else {
            panic!("not one licence link");
        };
        assert_eq!(code, &None);
        assert_eq!(
            offer.as_ref().map(|offer| offer.id.as_str()),
            Some(LICENCE_ID)
        );
    }

    #[test]
    fn a_launch_whose_urls_cannot_be_read_hands_over_none_and_logs_its_code() {
        crate::test_log::capture();
        let dir = tempfile::tempdir().expect("dir");
        let service = crate::licence::testing::licence(dir.path(), true);
        assert!(launch_links(Err(()), &service).is_empty());
        assert!(
            crate::test_log::lines()
                .iter()
                .any(|line| line == "WARN W_DEEP_LINK_LAUNCH_UNREAD")
        );
    }

    #[test]
    fn a_launch_hands_over_at_most_four_links_and_none_it_refuses() {
        let dir = tempfile::tempdir().expect("dir");
        let service = crate::licence::testing::licence(dir.path(), true);
        assert!(launch_links(Ok::<_, ()>(None), &service).is_empty());
        let mut urls = vec![format!("{SCHEME}://note/not-an-id")];
        urls.extend(vec![format!("{SCHEME}://today"); MAX_PER_EVENT + 2]);
        assert_eq!(
            launch_links(launched_with(&urls), &service),
            vec![Link::Today; MAX_PER_EVENT - 1]
        );
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
            |target, link| sent.push((target.clone(), link.clone())),
        );
        assert_eq!(sent, vec![(Target::Window("main".to_owned()), note())]);
    }

    #[test]
    fn links_wait_for_the_native_screens_and_a_page_that_has_listed_its_library() {
        let mut inbox = Inbox::default();
        assert!(inbox.arrive(note()).is_empty());
        assert!(
            inbox.screens_ready().is_empty(),
            "the first-launch notes may not be made yet"
        );
        assert!(inbox.arrive(command("view.trash")).is_empty());
        assert_eq!(inbox.take("main"), vec![note(), command("view.trash")]);
        assert_eq!(inbox.destination(Some("main")), Some(Target::Screens));
        assert_eq!(inbox.arrive(Link::Today), vec![Link::Today]);
        inbox.page_started("main");
        assert!(
            inbox.arrive(note()).is_empty(),
            "a reloaded page lists its library again first"
        );
        assert_eq!(inbox.take("main"), vec![note()]);
    }

    #[test]
    fn a_page_that_asks_under_the_native_screens_sends_the_links_there_in_order_and_gets_none() {
        let links = DeepLinks::default();
        links.with(|inbox| {
            inbox.arrive(note());
            inbox.arrive(command("view.trash"));
            inbox.screens_ready()
        });
        let mut screens = Vec::new();
        assert!(
            links
                .take_with("main", |link| screens.push(link.clone()))
                .is_empty()
        );
        assert_eq!(screens, vec![note(), command("view.trash")]);
        let mut sent = Vec::new();
        links.update_with(
            || None,
            |inbox| inbox.arrive(Link::Today),
            |target, link| sent.push((target.clone(), link.clone())),
        );
        assert_eq!(sent, vec![(Target::Screens, Link::Today)]);
    }

    #[test]
    fn a_page_that_asks_without_the_native_screens_takes_the_links_itself() {
        let links = DeepLinks::default();
        links.with(|inbox| inbox.arrive(note()));
        let mut screens = Vec::new();
        assert_eq!(
            links.take_with("main", |link| screens.push(link.clone())),
            vec![note()]
        );
        assert!(screens.is_empty());
    }

    #[test]
    fn the_iphone_answers_to_the_release_scheme_in_every_build() {
        let source = include_str!("deep_link.rs");
        assert!(source.contains(
            "pub(crate) const SCHEME: &str = if cfg!(debug_assertions) && !cfg!(target_os = \"ios\") {"
        ));
        let ios: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.ios.conf.json")).unwrap();
        assert_eq!(
            ios["plugins"]["deep-link"]["mobile"],
            serde_json::json!([{ "scheme": [RELEASE_SCHEME], "appLink": false }])
        );
        let plist = include_str!("../gen/apple/devot_iOS/Info.plist");
        assert!(plist.contains("<key>CFBundleURLSchemes</key>"));
        assert!(plist.contains(&format!("<string>{RELEASE_SCHEME}</string>")));
        assert!(!plist.contains(DEBUG_SCHEME));
        let project = include_str!("../gen/apple/project.yml");
        assert!(project.contains("CFBundleURLSchemes: [devot]"));
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
