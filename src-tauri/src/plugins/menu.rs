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
}

/// What enabled plugins put in the menus, by what their user granted, in plugin ID order.
pub fn plan(plugins: &[Installed]) -> Vec<Planned> {
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
                });
            }
        }
        if p.may("import") {
            for format in &m.contributes.import_formats {
                out.push(Planned {
                    place: Place::Import,
                    text: format!("{}…", format.title),
                    action: action(Kind::Import, &format.id),
                });
            }
        }
        if p.may("export") {
            for format in &m.contributes.export_formats {
                out.push(Planned {
                    place: Place::Export,
                    text: strings::PLUGIN_EXPORT_NOTE.replace("{title}", &format.title),
                    action: action(Kind::Export, &format.id),
                });
            }
        }
    }
    out
}

pub struct PluginMenus {
    pub plugins: Submenu<Wry>,
    pub import: Submenu<Wry>,
    pub export: Submenu<Wry>,
    added: Mutex<Vec<(Place, MenuItem<Wry>)>>,
    actions: Mutex<HashMap<String, Action>>,
}

impl PluginMenus {
    pub fn new(plugins: Submenu<Wry>, import: Submenu<Wry>, export: Submenu<Wry>) -> Self {
        Self {
            plugins,
            import,
            export,
            added: Mutex::new(Vec::new()),
            actions: Mutex::new(HashMap::new()),
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

/// Puts the menus in step with the installed plugins; Plugin Settings stays last in the Plugins menu.
pub fn refresh(app: &AppHandle) {
    let (Some(menus), Some(plugins)) = (
        app.try_state::<PluginMenus>(),
        app.try_state::<Arc<Plugins>>(),
    ) else {
        return;
    };
    let planned = plan(&plugins.list());
    let mut added = menus.added.lock().unwrap_or_else(|e| e.into_inner());
    let mut actions = menus.actions.lock().unwrap_or_else(|e| e.into_inner());
    for (place, item) in added.drain(..) {
        if menus.submenu(place).remove(&item).is_err() {
            log::warn!("W_PLUGIN_MENU_FAILED");
        }
    }
    actions.clear();
    let mut in_plugins = 0;
    for (n, item) in planned.into_iter().enumerate() {
        let id = format!("{ITEM_PREFIX}{n}");
        let Ok(built) = MenuItem::with_id(app, &id, &item.text, true, None::<&str>) else {
            log::warn!("W_PLUGIN_MENU_FAILED");
            continue;
        };
        let submenu = menus.submenu(item.place);
        let put = if item.place == Place::Plugins {
            in_plugins += 1;
            submenu.insert(&built, in_plugins - 1)
        } else {
            submenu.append(&built)
        };
        if put.is_err() {
            log::warn!("W_PLUGIN_MENU_FAILED");
            continue;
        }
        actions.insert(id, item.action);
        added.push((item.place, built));
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
    let action = app.try_state::<PluginMenus>().and_then(|menus| {
        menus
            .actions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
    });
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
        let planned = plan(&[installed(EVERYTHING, true, &all)]);
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
        assert!(plan(&[installed(EVERYTHING, false, &all)]).is_empty());
        let planned = plan(&[installed(EVERYTHING, true, &["commands", "export"])]);
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].place, Place::Export);
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
