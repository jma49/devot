//! A note in a window of its own (Shift+Return in the note list, or Open in New Window). Its page
//! (`note.html`) runs a core of its own beside the main window's, and every change either makes to
//! the note reaches the other at once (`note_relay`). Each note's window opens where it was last: frames
//! are kept in `note-windows.json`, a local preference like the editor settings. Closing it saves
//! first, as the main window does: Rust holds the close, asks the page to save, and closes on its
//! answer, or after a timeout so a stuck page never keeps it open. Quitting saves it too (`exit`).
//! Desktop only: a phone has one window.

use crate::commands::notes::valid_note_id;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(desktop)]
use {
    std::time::Duration,
    tauri::{
        AppHandle, Emitter, EventTarget, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
        Window, WindowEvent,
    },
};

const PREFIX: &str = "note-";
pub const FILE: &str = "note-windows.json";
pub const CLOSE_EVENT: &str = "devot://note-window-close";
#[cfg(desktop)]
const PAGE: &str = "note.html";
#[cfg(desktop)]
const SAVE_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_FRAMES: usize = 100;
const WIDTH: f64 = 720.0;
const HEIGHT: f64 = 780.0;
const MIN_WIDTH: f64 = 480.0;
const MIN_HEIGHT: f64 = 360.0;
const MAX_SIDE: f64 = 20_000.0;
/// How far a new window sits from the main window, so it never covers it exactly.
#[cfg(desktop)]
const CASCADE: f64 = 32.0;
/// How much of a window must be on a screen to open there: enough of its title bar to drag it.
const ON_SCREEN: f64 = 80.0;

pub fn label_for(id: &str) -> String {
    format!("{PREFIX}{id}")
}

/// The note a window shows, when it is a note window.
pub fn note_of(label: &str) -> Option<&str> {
    label.strip_prefix(PREFIX).filter(|id| valid_note_id(id))
}

/// In logical points: the outer position and the inner size.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Frame {
    fn valid(&self) -> bool {
        [self.x, self.y]
            .iter()
            .all(|v| v.is_finite() && v.abs() <= MAX_SIDE * 10.0)
            && (MIN_WIDTH..=MAX_SIDE).contains(&self.width)
            && (MIN_HEIGHT..=MAX_SIDE).contains(&self.height)
    }

    /// Whether enough of its top edge lies on one of `screens` to grab it.
    fn on_any(&self, screens: &[Frame]) -> bool {
        screens.iter().any(|s| {
            let across = (self.x + self.width).min(s.x + s.width) - self.x.max(s.x);
            let top_inside = self.y >= s.y && self.y < s.y + s.height - ON_SCREEN / 2.0;
            across >= ON_SCREEN && top_inside
        })
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredFrame {
    id: String,
    #[serde(flatten)]
    frame: Frame,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Stored {
    #[serde(default)]
    frames: Vec<serde_json::Value>,
}

/// The frames of the last MAX_FRAMES note windows, the most recent last.
#[derive(Debug, Default, PartialEq)]
struct Frames(Vec<(String, Frame)>);

impl Frames {
    /// Leniently: an entry that does not read is skipped, a file that does not is no frames.
    fn parse(bytes: &[u8]) -> Self {
        let stored: Stored = serde_json::from_slice(bytes).unwrap_or_default();
        let mut frames = Self::default();
        for value in stored.frames {
            if let Ok(entry) = serde_json::from_value::<StoredFrame>(value)
                && valid_note_id(&entry.id)
                && entry.frame.valid()
            {
                frames.remember(&entry.id, entry.frame);
            }
        }
        frames
    }

    fn to_json(&self) -> Vec<u8> {
        let frames: Vec<_> = self
            .0
            .iter()
            .map(|(id, frame)| StoredFrame {
                id: id.clone(),
                frame: *frame,
            })
            .collect();
        serde_json::to_vec_pretty(&serde_json::json!({ "frames": frames })).unwrap_or_default()
    }

    fn get(&self, id: &str) -> Option<Frame> {
        self.0.iter().find(|(kept, _)| kept == id).map(|(_, f)| *f)
    }

    fn remember(&mut self, id: &str, frame: Frame) -> bool {
        if !frame.valid() || self.0.last().is_some_and(|(k, f)| k == id && *f == frame) {
            return false;
        }
        self.0.retain(|(kept, _)| kept != id);
        self.0.push((id.to_owned(), frame));
        let over = self.0.len().saturating_sub(MAX_FRAMES);
        self.0.drain(..over);
        true
    }
}

/// The frames and the closes under way.
pub struct NoteWindows {
    path: PathBuf,
    /// None until first used; then also what is written.
    frames: Mutex<Option<(Frames, bool)>>,
    /// The note windows asked to save before they close, by the round of the ask.
    closing: Mutex<HashMap<String, u64>>,
    rounds: AtomicU64,
}

impl NoteWindows {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join(FILE),
            frames: Mutex::new(None),
            closing: Mutex::new(HashMap::new()),
            rounds: AtomicU64::new(0),
        }
    }

    fn with_frames<T>(&self, f: impl FnOnce(&mut Frames, &mut bool) -> T) -> T {
        let mut held = self.frames.lock().unwrap_or_else(|e| e.into_inner());
        let (frames, changed) = held.get_or_insert_with(|| {
            let read = std::fs::read(&self.path).unwrap_or_default();
            (Frames::parse(&read), false)
        });
        f(frames, changed)
    }

    pub fn frame(&self, id: &str) -> Option<Frame> {
        self.with_frames(|frames, _| frames.get(id))
    }

    pub fn remember(&self, id: &str, frame: Frame) {
        self.with_frames(|frames, changed| *changed |= frames.remember(id, frame));
    }

    /// Writes the frames when they changed since the last write.
    pub fn persist(&self) {
        let json =
            self.with_frames(|frames, changed| std::mem::take(changed).then(|| frames.to_json()));
        if let Some(json) = json
            && crate::atomic_file::write_replacing(&self.path, &json).is_err()
        {
            log::warn!("W_NOTE_WINDOW_FRAMES_WRITE_FAILED");
        }
    }

    /// The round of a new ask to save before closing, or None while one is under way.
    fn begin_close(&self, label: &str) -> Option<u64> {
        let mut closing = self.closing.lock().unwrap_or_else(|e| e.into_inner());
        if closing.contains_key(label) {
            return None;
        }
        let round = self.rounds.fetch_add(1, Ordering::SeqCst) + 1;
        closing.insert(label.to_owned(), round);
        Some(round)
    }

    /// The ask is answered or called off; whether one was under way.
    fn end_close(&self, label: &str) -> bool {
        let mut closing = self.closing.lock().unwrap_or_else(|e| e.into_inner());
        closing.remove(label).is_some()
    }

    /// Whether the ask of `round` is still unanswered: the window closes without its answer.
    fn timed_out(&self, label: &str, round: u64) -> bool {
        let mut closing = self.closing.lock().unwrap_or_else(|e| e.into_inner());
        let late = closing.get(label) == Some(&round);
        if late {
            closing.remove(label);
        }
        late
    }
}

#[cfg(desktop)]
fn screens(app: &AppHandle) -> Vec<Frame> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| {
            let scale = monitor.scale_factor();
            let position = monitor.position().to_logical::<f64>(scale);
            let size = monitor.size().to_logical::<f64>(scale);
            Frame {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
            }
        })
        .collect()
}

#[cfg(desktop)]
fn frame_of(window: &Window) -> Option<Frame> {
    if window.is_minimized().unwrap_or(true) || window.is_fullscreen().unwrap_or(true) {
        return None;
    }
    let scale = window.scale_factor().ok()?;
    let position = window.outer_position().ok()?.to_logical::<f64>(scale);
    let size = window.inner_size().ok()?.to_logical::<f64>(scale);
    Some(Frame {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    })
}

/// Next to the main window when there is no frame of the note's own to open in.
#[cfg(desktop)]
fn beside_main(app: &AppHandle) -> Option<(f64, f64)> {
    let main = app.get_webview_window(crate::MAIN_WINDOW)?;
    if !main.is_visible().unwrap_or(false) {
        return None;
    }
    let scale = main.scale_factor().ok()?;
    let at = main.outer_position().ok()?.to_logical::<f64>(scale);
    Some((at.x + CASCADE, at.y + CASCADE))
}

#[cfg(desktop)]
fn bring_forward(window: &WebviewWindow) {
    if crate::deep_link::unminimize(window)
        .and(window.show())
        .and(window.set_focus())
        .is_err()
    {
        log::warn!("W_NOTE_WINDOW_FOCUS_FAILED");
    }
}

#[cfg(desktop)]
pub fn open(app: &AppHandle, id: &str) -> Result<(), &'static str> {
    if !valid_note_id(id) {
        return Err("E_NOTE_ID_INVALID");
    }
    let label = label_for(id);
    if let Some(window) = app.get_webview_window(&label) {
        bring_forward(&window);
        return Ok(());
    }
    let stored = app
        .try_state::<std::sync::Arc<crate::editor_settings::EditorSettingsStore>>()
        .and_then(|store| store.get().ok());
    let theme = stored
        .as_ref()
        .and_then(|stored| stored.settings.appearance.window_theme());
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(PAGE.into()));
    // The same WebKit store as the main window (`data_folder`).
    if let Some(store) = crate::data_folder::this_build_web_data_store() {
        builder = builder.data_store_identifier(store);
    }
    if let Some(stored) = &stored {
        builder = builder.initialization_script(crate::editor_settings::initial_script(stored));
    }
    let remembered = app
        .try_state::<NoteWindows>()
        .and_then(|windows| windows.frame(id))
        .filter(|frame| frame.on_any(&screens(app)));
    builder = match (remembered, beside_main(app)) {
        (Some(frame), _) => builder
            .inner_size(frame.width, frame.height)
            .position(frame.x, frame.y),
        (None, Some((x, y))) => builder.inner_size(WIDTH, HEIGHT).position(x, y),
        (None, None) => builder.inner_size(WIDTH, HEIGHT).center(),
    };
    let window = builder
        .title(crate::strings::NOTE_WINDOW_TITLE)
        .theme(theme)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .on_new_window(crate::external::on_new_window)
        .build()
        .map_err(|_| "E_NOTE_WINDOW_OPEN_FAILED")?;
    bring_forward(&window);
    Ok(())
}

/// Asks the page to save, and closes the window once it has, or after SAVE_TIMEOUT.
#[cfg(desktop)]
fn close_after_saving(window: &Window) {
    let app = window.app_handle();
    let Some(windows) = app.try_state::<NoteWindows>() else {
        return;
    };
    let label = window.label().to_owned();
    let Some(round) = windows.begin_close(&label) else {
        return;
    };
    if app
        .emit_to(EventTarget::webview_window(&label), CLOSE_EVENT, ())
        .is_err()
    {
        windows.end_close(&label);
        destroy(window);
        return;
    }
    let window = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SAVE_TIMEOUT);
        let app = window.app_handle();
        if app
            .try_state::<NoteWindows>()
            .is_some_and(|windows| windows.timed_out(&label, round))
        {
            log::warn!("W_NOTE_WINDOW_SAVE_TIMEOUT");
            destroy(&window);
        }
    });
}

#[cfg(desktop)]
fn destroy(window: &Window) {
    if window.destroy().is_err() {
        log::warn!("W_NOTE_WINDOW_CLOSE_FAILED");
    }
}

#[cfg(desktop)]
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let Some(id) = note_of(window.label()) else {
        return;
    };
    let app = window.app_handle();
    let Some(windows) = app.try_state::<NoteWindows>() else {
        return;
    };
    match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            if let Some(frame) = frame_of(window) {
                windows.remember(id, frame);
            }
        }
        // While the app exits, its windows go with it; the quit saved them (`exit`).
        WindowEvent::CloseRequested { api, .. } if !crate::exit::exiting(app) => {
            api.prevent_close();
            close_after_saving(window);
        }
        WindowEvent::Destroyed => {
            windows.end_close(window.label());
            windows.persist();
        }
        _ => {}
    }
}

/// From the main window, or a note window opening a note it links to.
#[cfg(desktop)]
#[tauri::command]
pub fn note_window_open(app: AppHandle, window: WebviewWindow, id: String) -> Result<(), String> {
    if !crate::note_relay::may_relay(window.label()) {
        return Err("E_NOTE_WINDOW_FROM".into());
    }
    open(&app, &id).map_err(String::from)
}

/// The note the asking window shows.
#[cfg(desktop)]
#[tauri::command]
pub fn note_window_note(window: WebviewWindow) -> Result<String, String> {
    note_of(window.label())
        .map(str::to_owned)
        .ok_or_else(|| "E_NOTE_WINDOW_ONLY".into())
}

/// The page saved after a close was asked: the window closes now.
#[cfg(desktop)]
#[tauri::command]
pub fn note_window_close_ready(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    note_of(window.label()).ok_or("E_NOTE_WINDOW_ONLY")?;
    if let Some(windows) = app.try_state::<NoteWindows>() {
        windows.end_close(window.label());
    }
    window
        .destroy()
        .map_err(|_| String::from("E_NOTE_WINDOW_CLOSE_FAILED"))
}

/// The page could not save: the window stays, its notice says so, and the next close goes on.
#[cfg(desktop)]
#[tauri::command]
pub fn note_window_close_cancel(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    note_of(window.label()).ok_or("E_NOTE_WINDOW_ONLY")?;
    log::warn!("W_NOTE_WINDOW_CLOSE_CALLED_OFF");
    if let Some(windows) = app.try_state::<NoteWindows>() {
        windows.end_close(window.label());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0192a6f0-0000-7000-8000-000000000001";

    fn frame(x: f64, y: f64) -> Frame {
        Frame {
            x,
            y,
            width: 700.0,
            height: 600.0,
        }
    }

    #[test]
    fn a_note_window_is_named_after_its_note() {
        assert_eq!(note_of(&label_for(ID)), Some(ID));
        assert_eq!(note_of("main"), None);
        assert_eq!(note_of("note-"), None);
        assert_eq!(note_of("note-0192A6F0-0000-7000-8000-000000000001"), None);
        assert_eq!(note_of(&format!("x{}", label_for(ID))), None);
    }

    #[test]
    fn keeps_the_last_frame_of_each_note_most_recent_last_and_a_bounded_number() {
        let mut frames = Frames::default();
        assert!(frames.remember(ID, frame(10.0, 20.0)));
        assert!(!frames.remember(ID, frame(10.0, 20.0)), "unchanged");
        assert!(frames.remember(ID, frame(30.0, 40.0)));
        assert_eq!(frames.get(ID), Some(frame(30.0, 40.0)));
        for i in 0..MAX_FRAMES {
            let id = format!("0192a6f0-0000-7000-9000-{i:012}");
            frames.remember(&id, frame(0.0, 0.0));
        }
        assert_eq!(frames.0.len(), MAX_FRAMES);
        assert_eq!(frames.get(ID), None, "the oldest went");
    }

    #[test]
    fn refuses_frames_no_window_could_have() {
        let mut frames = Frames::default();
        for bad in [
            Frame {
                width: MIN_WIDTH - 1.0,
                ..frame(0.0, 0.0)
            },
            Frame {
                height: f64::INFINITY,
                ..frame(0.0, 0.0)
            },
            frame(f64::NAN, 0.0),
        ] {
            assert!(!frames.remember(ID, bad), "{bad:?}");
        }
        assert_eq!(frames.get(ID), None);
    }

    #[test]
    fn reads_the_file_leniently_and_writes_what_it_reads() {
        let json = format!(
            r#"{{"frames":[
                {{"id":"{ID}","x":1,"y":2,"width":700,"height":600}},
                {{"id":"not a note","x":1,"y":2,"width":700,"height":600}},
                {{"id":"{ID}","x":"far"}},
                7
            ]}}"#
        );
        let frames = Frames::parse(json.as_bytes());
        assert_eq!(
            frames.0,
            [(
                ID.to_owned(),
                Frame {
                    x: 1.0,
                    y: 2.0,
                    width: 700.0,
                    height: 600.0
                }
            )]
        );
        assert_eq!(Frames::parse(&frames.to_json()), frames);
        assert_eq!(Frames::parse(b"{ not json"), Frames::default());
        assert_eq!(Frames::parse(b""), Frames::default());
    }

    #[test]
    fn opens_where_it_was_only_when_its_title_bar_is_on_a_screen() {
        let screens = [Frame {
            x: 0.0,
            y: 0.0,
            width: 1440.0,
            height: 900.0,
        }];
        assert!(frame(100.0, 100.0).on_any(&screens));
        assert!(
            frame(-600.0, 100.0).on_any(&screens),
            "mostly off to the left"
        );
        assert!(
            !frame(-690.0, 100.0).on_any(&screens),
            "too little left to grab"
        );
        assert!(
            !frame(100.0, -50.0).on_any(&screens),
            "title bar above the screen"
        );
        assert!(
            !frame(2000.0, 100.0).on_any(&screens),
            "a screen no longer there"
        );
        assert!(!frame(100.0, 100.0).on_any(&[]));
    }

    #[test]
    fn keeps_frames_in_the_data_folder_across_starts() {
        let dir = tempfile::tempdir().unwrap();
        let windows = NoteWindows::new(dir.path());
        windows.remember(ID, frame(5.0, 6.0));
        windows.persist();
        assert_eq!(
            NoteWindows::new(dir.path()).frame(ID),
            Some(frame(5.0, 6.0))
        );
        let written = std::fs::read(dir.path().join(FILE)).unwrap();
        windows.persist();
        assert_eq!(
            std::fs::read(dir.path().join(FILE)).unwrap(),
            written,
            "nothing new"
        );
    }

    #[test]
    fn asks_a_window_to_save_once_until_it_answers_or_the_ask_times_out() {
        let dir = tempfile::tempdir().unwrap();
        let windows = NoteWindows::new(dir.path());
        let label = label_for(ID);
        let first = windows.begin_close(&label).unwrap();
        assert_eq!(windows.begin_close(&label), None, "one ask at a time");
        assert!(windows.end_close(&label));
        assert!(!windows.timed_out(&label, first), "answered: no timeout");
        let second = windows.begin_close(&label).unwrap();
        assert!(
            !windows.timed_out(&label, first),
            "an older ask's timeout does nothing"
        );
        assert!(windows.timed_out(&label, second));
        assert!(
            windows.begin_close(&label).is_some(),
            "a later close asks again"
        );
    }
}
