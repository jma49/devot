//! Plugins' items in the menu bar (ADR 0005), built from the installed manifests, never from the page: their commands in the
//! Plugins menu, their import formats in File > Import and export formats in File > Export. A pick reaches the main window as
//! `devot://plugin-action`, which names the plugin and what it contributed, and the window asks the plugin.

use super::{Installed, Plugins};
use crate::strings;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::menu::{MenuItem, Submenu};
use tauri::{AppHandle, Manager, Wry};

pub const ACTION_EVENT: &str = "devot://plugin-action";
pub const SETTINGS_ID: &str = "devot.plugins.settings";
const ITEM_PREFIX: &str = "devot.plugin.";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Command,
    Import,
    Export,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Action {
    pub kind: Kind,
    pub plugin: String,
    pub id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Place {
    Plugins,
    Import,
    Export,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Planned {
    pub place: Place,
    pub text: String,
    pub action: Action,
    /// Imports make notes, so they are off while the licence blocks writes.
    pub enabled: bool,
}

/// What enabled plugins put in the menus, by what their user granted, in plugin ID order.
pub fn plan(plugins: &[Installed], editing: bool) -> Vec<Planned> {
    let mut out = Vec::new();
    for p in plugins.iter().filter(|p| p.enabled) {
        let m = &p.manifest;
        let action = |kind: Kind, id: &str| Action {
            kind,
            plugin: m.id.clone(),
            id: id.to_string(),
        };
        if p.may("menus") && p.may("commands") {
            for item in &m.contributes.menus {
                let Some(command) = m.contributes.commands.iter().find(|c| c.id == item.command)
                else {
                    continue;
                };
                out.push(Planned {
                    place: Place::Plugins,
                    text: command.title.clone(),
                    action: action(Kind::Command, &command.id),
                    enabled: true,
                });
            }
        }
        if p.may("import") {
            for format in &m.contributes.import_formats {
                out.push(Planned {
                    place: Place::Import,
                    text: format!("{}…", format.title),
                    action: action(Kind::Import, &format.id),
                    enabled: editing,
                });
            }
        }
        if p.may("export") {
            for format in &m.contributes.export_formats {
                out.push(Planned {
                    place: Place::Export,
                    text: strings::PLUGIN_EXPORT_NOTE.replace("{title}", &format.title),
                    action: action(Kind::Export, &format.id),
                    enabled: true,
                });
            }
        }
    }
    out
}

/// Where a rebuild puts and takes its items: the app's menu bar, or a stand-in in tests.
trait Bar {
    type Item;
    fn remove(&self, place: Place, item: &Self::Item) -> bool;
    /// `at` is the item's position in the Plugins menu; the other places append.
    fn add(&self, id: &str, item: &Planned, at: Option<usize>) -> Option<Self::Item>;
}

struct Table<I> {
    added: Mutex<Vec<(Place, I)>>,
    actions: Mutex<HashMap<String, Action>>,
}

impl<I> Table<I> {
    fn new() -> Self {
        Self {
            added: Mutex::new(Vec::new()),
            actions: Mutex::new(HashMap::new()),
        }
    }

    fn action(&self, id: &str) -> Option<Action> {
        crate::locks::lock(&self.actions).get(id).cloned()
    }

    /// Holds no lock while it changes the menu bar, whose changes wait on the main thread.
    fn rebuild(&self, bar: &impl Bar<Item = I>, planned: Vec<Planned>) {
        let old = std::mem::take(&mut *crate::locks::lock(&self.added));
        for (place, item) in old {
            if !bar.remove(place, &item) {
                log::warn!("W_PLUGIN_MENU_FAILED");
            }
        }
        let mut added = Vec::new();
        let mut actions = HashMap::new();
        let mut in_plugins = 0;
        for (n, item) in planned.into_iter().enumerate() {
            let id = format!("{ITEM_PREFIX}{n}");
            let at = (item.place == Place::Plugins).then_some(in_plugins);
            let Some(built) = bar.add(&id, &item, at) else {
                log::warn!("W_PLUGIN_MENU_FAILED");
                continue;
            };
            if at.is_some() {
                in_plugins += 1;
            }
            added.push((item.place, built));
            actions.insert(id, item.action);
        }
        *crate::locks::lock(&self.actions) = actions;
        crate::locks::lock(&self.added).extend(added);
    }
}

pub struct PluginMenus {
    pub plugins: Submenu<Wry>,
    pub import: Submenu<Wry>,
    pub export: Submenu<Wry>,
    table: Table<MenuItem<Wry>>,
}

impl PluginMenus {
    pub fn new(plugins: Submenu<Wry>, import: Submenu<Wry>, export: Submenu<Wry>) -> Self {
        Self {
            plugins,
            import,
            export,
            table: Table::new(),
        }
    }

    fn submenu(&self, place: Place) -> &Submenu<Wry> {
        match place {
            Place::Plugins => &self.plugins,
            Place::Import => &self.import,
            Place::Export => &self.export,
        }
    }
}

/// `refresh` on the main thread, so rebuilds never overlap and their menu changes run there directly.
pub fn refresh_on_main_thread(app: &AppHandle) {
    let handle = app.clone();
    if app.run_on_main_thread(move || refresh(&handle)).is_err() {
        log::warn!("W_PLUGIN_MENU_FAILED");
    }
}

/// Puts the menus in step with the installed plugins; Plugin Settings stays last in the Plugins menu.
pub fn refresh(app: &AppHandle) {
    let (Some(menus), Some(plugins)) = (
        app.try_state::<PluginMenus>(),
        app.try_state::<Arc<Plugins>>(),
    ) else {
        return;
    };
    let editing = app
        .try_state::<Arc<crate::licence::Licence>>()
        .is_none_or(|licence| {
            licence
                .require_write(crate::storage::Write::Content)
                .is_ok()
        });
    let planned = plan(&plugins.list(), editing);
    let bar = AppBar { app, menus: &menus };
    menus.table.rebuild(&bar, planned);
}

struct AppBar<'a> {
    app: &'a AppHandle,
    menus: &'a PluginMenus,
}

impl Bar for AppBar<'_> {
    type Item = MenuItem<Wry>;

    fn remove(&self, place: Place, item: &MenuItem<Wry>) -> bool {
        self.menus.submenu(place).remove(item).is_ok()
    }

    fn add(&self, id: &str, item: &Planned, at: Option<usize>) -> Option<MenuItem<Wry>> {
        let built = MenuItem::with_id(self.app, id, &item.text, item.enabled, None::<&str>).ok()?;
        let submenu = self.menus.submenu(item.place);
        let put = match at {
            Some(at) => submenu.insert(&built, at),
            None => submenu.append(&built),
        };
        put.ok().map(|()| built)
    }
}

/// True when the menu item was a plugin's (or Plugin Settings).
pub fn on_menu_event(app: &AppHandle, id: &str) -> bool {
    if id == SETTINGS_ID {
        crate::settings::open(app);
        return true;
    }
    if !id.starts_with(ITEM_PREFIX) {
        return false;
    }
    let action = app
        .try_state::<PluginMenus>()
        .and_then(|menus| menus.table.action(id));
    if let Some(action) = action
        && crate::main_windows::emit_front(app, ACTION_EVENT, action).is_err()
    {
        log::warn!("W_PLUGIN_MENU_EMIT_FAILED");
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::manifest;

    fn installed(json: &str, enabled: bool, granted: &[&str]) -> Installed {
        let manifest = manifest::parse_bytes(json.as_bytes()).unwrap();
        Installed {
            manifest,
            enabled,
            granted: granted.iter().map(|g| g.to_string()).collect(),
            installed_at: 0,
        }
    }

    const EVERYTHING: &str = r#"{"id":"com.example.all","name":"All","version":"1.0.0","apiVersion":1,"main":"main.js",
        "permissions":["commands","menus","import","export"],
        "contributes":{"commands":[{"id":"a","title":"Do A"},{"id":"b","title":"Do B"}],"menus":[{"command":"b"}],
        "importFormats":[{"id":"org","title":"Org Files","extensions":["org"]}],
        "exportFormats":[{"id":"org","title":"Org","extension":"org"}]}}"#;

    #[test]
    fn plans_menu_items_from_what_was_granted() {
        let all = ["commands", "menus", "import", "export"];
        let planned = plan(&[installed(EVERYTHING, true, &all)], true);
        let shown: Vec<_> = planned
            .iter()
            .map(|p| (p.place, p.text.as_str(), p.action.id.as_str()))
            .collect();
        assert_eq!(
            shown,
            [
                (Place::Plugins, "Do B", "b"),
                (Place::Import, "Org Files…", "org"),
                (Place::Export, "Note as Org…", "org"),
            ]
        );
        assert_eq!(planned[0].action.kind, Kind::Command);
        assert_eq!(planned[0].action.plugin, "com.example.all");
    }

    #[test]
    fn leaves_out_disabled_plugins_and_what_was_not_granted() {
        let all = ["commands", "menus", "import", "export"];
        assert!(plan(&[installed(EVERYTHING, false, &all)], true).is_empty());
        let planned = plan(
            &[installed(EVERYTHING, true, &["commands", "export"])],
            true,
        );
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].place, Place::Export);
    }

    #[test]
    fn disables_imports_while_editing_is_locked() {
        let all = ["commands", "menus", "import", "export"];
        let planned = plan(&[installed(EVERYTHING, true, &all)], false);
        let shown: Vec<_> = planned.iter().map(|p| (p.place, p.enabled)).collect();
        assert_eq!(
            shown,
            [
                (Place::Plugins, true),
                (Place::Import, false),
                (Place::Export, true),
            ]
        );
    }

    type Task = Box<dyn FnOnce() + Send>;

    /// A menu bar whose changes run on one thread, as AppKit's do: a change from another thread
    /// is posted there and waits for its reply.
    struct MainThreadBar {
        main: std::thread::ThreadId,
        post: Mutex<std::sync::mpsc::Sender<Option<Task>>>,
        shown: Arc<Mutex<Vec<(u64, String)>>>,
        serial: std::sync::atomic::AtomicU64,
    }

    impl MainThreadBar {
        fn run<T: Send + 'static>(&self, change: impl FnOnce() -> T + Send + 'static) -> T {
            if std::thread::current().id() == self.main {
                return change();
            }
            let (reply, answer) = std::sync::mpsc::channel();
            let task: Task = Box::new(move || {
                let _ = reply.send(change());
            });
            self.post.lock().unwrap().send(Some(task)).unwrap();
            answer.recv().unwrap()
        }
    }

    impl Bar for MainThreadBar {
        type Item = u64;

        fn remove(&self, _: Place, item: &u64) -> bool {
            let (shown, item) = (Arc::clone(&self.shown), *item);
            self.run(move || shown.lock().unwrap().retain(|(serial, _)| *serial != item));
            true
        }

        fn add(&self, id: &str, _: &Planned, _: Option<usize>) -> Option<u64> {
            let serial = self
                .serial
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let (shown, id) = (Arc::clone(&self.shown), id.to_string());
            self.run(move || shown.lock().unwrap().push((serial, id)));
            Some(serial)
        }
    }

    fn planned() -> Vec<Planned> {
        let all = ["commands", "menus", "import", "export"];
        plan(&[installed(EVERYTHING, true, &all)], true)
    }

    #[test]
    fn a_rebuild_off_the_main_thread_lets_the_main_thread_pick_and_rebuild() {
        let (finished, done) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (post, tasks) = std::sync::mpsc::channel::<Option<Task>>();
            let bar = Arc::new(MainThreadBar {
                main: std::thread::current().id(),
                post: Mutex::new(post),
                shown: Arc::new(Mutex::new(Vec::new())),
                serial: Default::default(),
            });
            let table = Arc::new(Table::new());
            table.rebuild(&*bar, planned());
            let worker = std::thread::spawn({
                let (bar, table) = (Arc::clone(&bar), Arc::clone(&table));
                move || {
                    table.rebuild(&*bar, planned());
                    bar.post.lock().unwrap().send(None).unwrap();
                }
            });
            let first = tasks.recv().unwrap();
            let picked = table.action(&format!("{ITEM_PREFIX}0"));
            table.rebuild(&*bar, planned());
            for task in std::iter::once(first).chain(tasks.iter()) {
                let Some(task) = task else { break };
                task();
            }
            worker.join().unwrap();
            table.rebuild(&*bar, planned());
            let shown: Vec<String> = bar
                .shown
                .lock()
                .unwrap()
                .iter()
                .map(|(_, id)| id.clone())
                .collect();
            let _ = finished.send((picked, shown));
        });
        let (picked, shown) = done
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("a pick and a rebuild on the main thread finish while another rebuild runs");
        assert!(picked.is_none_or(|action| action.id == "b"));
        assert_eq!(
            shown,
            [
                format!("{ITEM_PREFIX}0"),
                format!("{ITEM_PREFIX}1"),
                format!("{ITEM_PREFIX}2"),
            ]
        );
    }

    #[test]
    fn sends_actions_as_the_page_reads_them() {
        let action = Action {
            kind: Kind::Import,
            plugin: "p".into(),
            id: "f".into(),
        };
        assert_eq!(
            serde_json::to_value(action).unwrap(),
            serde_json::json!({ "kind": "import", "plugin": "p", "id": "f" })
        );
    }
}
