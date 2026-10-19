//! The Format menu: an item for every `format.*` command of the command registry
//! (`src/renderer/src/commands/registry.ts`; a test compares the two). Picking one sends
//! `devot://format` with the command's ID to the main window.
//! Why a menu: some keys (Command-I) never reached the page; the web view took them as key
//! equivalents and passed them on to nothing. On macOS a key monitor
//! (`native::macos::give_format_menu_keys_priority`) offers every Command or Control key to this
//! menu before the web view sees it. The menu holds no keys of its own: the UI sets them
//! (`format_menu_set`) while the editor has the keyboard and takes them away (greying the items
//! out) when it does not, so a format key never shadows what the same key does elsewhere (Command-K
//! opens the command palette outside the editor).

use crate::strings;
use std::collections::HashMap;
use tauri::menu::{MenuItem, MenuItemBuilder, Submenu, SubmenuBuilder};
use tauri::{App, AppHandle, Emitter, State, Wry};

pub const FORMAT_EVENT: &str = "devot://format";
const ID_PREFIX: &str = "devot.";
const MAX_ACCELERATOR_LEN: usize = 64;

pub struct Item {
    pub command: &'static str,
    pub label: &'static str,
}

pub enum Entry {
    Item(Item),
    Separator,
    Submenu(&'static str, &'static [Item]),
}

const fn item(command: &'static str, label: &'static str) -> Item {
    Item { command, label }
}

pub const FORMAT_MENU: &[Entry] = &[
    Entry::Item(item("format.bold", strings::FORMAT_BOLD)),
    Entry::Item(item("format.italic", strings::FORMAT_ITALIC)),
    Entry::Item(item("format.strikethrough", strings::FORMAT_STRIKETHROUGH)),
    Entry::Item(item("format.highlight", strings::FORMAT_HIGHLIGHT)),
    Entry::Item(item("format.code", strings::FORMAT_INLINE_CODE)),
    Entry::Item(item("format.link", strings::FORMAT_LINK)),
    Entry::Separator,
    Entry::Submenu(
        strings::FORMAT_HEADING,
        &[
            item("format.heading1", strings::FORMAT_HEADING_1),
            item("format.heading2", strings::FORMAT_HEADING_2),
            item("format.heading3", strings::FORMAT_HEADING_3),
            item("format.heading4", strings::FORMAT_HEADING_4),
            item("format.heading5", strings::FORMAT_HEADING_5),
            item("format.heading6", strings::FORMAT_HEADING_6),
            item("format.headingBigger", strings::FORMAT_HEADING_BIGGER),
            item("format.headingSmaller", strings::FORMAT_HEADING_SMALLER),
        ],
    ),
    Entry::Separator,
    Entry::Item(item("format.codeBlock", strings::FORMAT_CODE_BLOCK)),
    Entry::Item(item("format.bulletList", strings::FORMAT_BULLET_LIST)),
    Entry::Item(item("format.numberedList", strings::FORMAT_NUMBERED_LIST)),
    Entry::Item(item("format.taskList", strings::FORMAT_TASK_LIST)),
    Entry::Item(item("format.quote", strings::FORMAT_QUOTE)),
    Entry::Submenu(
        strings::FORMAT_ALERT,
        &[
            item("format.alertNote", strings::FORMAT_ALERT_NOTE),
            item("format.alertTip", strings::FORMAT_ALERT_TIP),
            item("format.alertImportant", strings::FORMAT_ALERT_IMPORTANT),
            item("format.alertWarning", strings::FORMAT_ALERT_WARNING),
            item("format.alertCaution", strings::FORMAT_ALERT_CAUTION),
        ],
    ),
    Entry::Separator,
    Entry::Item(item(
        "format.horizontalRule",
        strings::FORMAT_HORIZONTAL_RULE,
    )),
];

pub fn items() -> impl Iterator<Item = &'static Item> {
    FORMAT_MENU.iter().flat_map(|entry| match entry {
        Entry::Item(item) => std::slice::from_ref(item),
        Entry::Separator => &[],
        Entry::Submenu(_, items) => *items,
    })
}

pub fn menu_id(command: &str) -> String {
    format!("{ID_PREFIX}{command}")
}

pub fn command_for(menu_id: &str) -> Option<&'static str> {
    let command = menu_id.strip_prefix(ID_PREFIX)?;
    items()
        .find(|item| item.command == command)
        .map(|item| item.command)
}

pub struct FormatMenu(Vec<(&'static str, MenuItem<Wry>)>);

pub fn build(app: &App) -> tauri::Result<(Submenu<Wry>, FormatMenu)> {
    let mut built = Vec::new();
    let mut new_item = |item: &Item| -> tauri::Result<MenuItem<Wry>> {
        let menu_item = MenuItemBuilder::with_id(menu_id(item.command), item.label)
            .enabled(false)
            .build(app)?;
        built.push((item.command, menu_item.clone()));
        Ok(menu_item)
    };
    let mut menu = SubmenuBuilder::new(app, strings::MENU_FORMAT);
    for entry in FORMAT_MENU {
        menu = match entry {
            Entry::Item(item) => menu.item(&new_item(item)?),
            Entry::Separator => menu.separator(),
            Entry::Submenu(label, items) => {
                let mut submenu = SubmenuBuilder::new(app, *label);
                for item in *items {
                    submenu = submenu.item(&new_item(item)?);
                }
                menu.item(&submenu.build()?)
            }
        };
    }
    Ok((menu.build()?, FormatMenu(built)))
}

pub fn on_menu_event(app: &AppHandle, menu_id: &str) -> bool {
    let Some(command) = command_for(menu_id) else {
        return false;
    };
    if app.emit_to("main", FORMAT_EVENT, command).is_err() {
        log::warn!("W_FORMAT_MENU_EMIT_FAILED");
    }
    true
}

const MOD_CTRL: u8 = 1;
const MOD_SHIFT: u8 = 2;
const MOD_ALT: u8 = 4;
const MOD_CMD: u8 = 8;

/// Spelled as `shortcutAccelerator` does (src/renderer/src/commands/keys.ts).
fn known_key(key: &str) -> bool {
    const NAMED: &[&str] = &[
        "Enter",
        "Backspace",
        "Delete",
        "Escape",
        "Tab",
        "Space",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        "PageUp",
        "PageDown",
    ];
    let mut chars = key.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) => {
            c.is_ascii_uppercase() || c.is_ascii_digit() || ".,/;'[]\\-=`".contains(c)
        }
        _ => {
            NAMED.contains(&key)
                || key
                    .strip_prefix('F')
                    .and_then(|n| n.parse::<u8>().ok())
                    .is_some_and(|n| (1..=12).contains(&n) && !key.starts_with("F0"))
        }
    }
}

/// It needs Command or Control, so it can never take a key that types text.
pub(crate) fn parse_accelerator(accelerator: &str) -> Option<(u8, &str)> {
    if accelerator.len() > MAX_ACCELERATOR_LEN {
        return None;
    }
    let (modifiers, key) = accelerator.rsplit_once('+')?;
    let mut mods = 0;
    for part in modifiers.split('+') {
        let bit = match part {
            "Ctrl" => MOD_CTRL,
            "Shift" => MOD_SHIFT,
            "Alt" => MOD_ALT,
            "CmdOrCtrl" => MOD_CMD,
            _ => return None,
        };
        if mods & bit != 0 {
            return None;
        }
        mods |= bit;
    }
    (mods & (MOD_CMD | MOD_CTRL) != 0 && known_key(key)).then_some((mods, key))
}

/// Keys the menu bar's own items have (`menu.rs`'s Quit and Settings and the standard Edit, Window,
/// View and app items); no command's key may take them. The View items that run a command have the
/// command's keys instead, which the UI sets (`menu::command_menu_set`).
pub(crate) const MENU_BAR_KEYS: &[&str] = &[
    "CmdOrCtrl+Q",
    "CmdOrCtrl+,",
    "CmdOrCtrl+H",
    "Alt+CmdOrCtrl+H",
    "CmdOrCtrl+Z",
    "Shift+CmdOrCtrl+Z",
    "CmdOrCtrl+X",
    "CmdOrCtrl+C",
    "CmdOrCtrl+V",
    "CmdOrCtrl+A",
    "Ctrl+CmdOrCtrl+F",
    "CmdOrCtrl+M",
    "CmdOrCtrl+W",
];

pub fn plan(
    keys: &HashMap<String, String>,
) -> Result<Vec<(&'static str, Option<String>)>, &'static str> {
    let mut seen = Vec::new();
    for (command, accelerator) in keys {
        if command_for(&menu_id(command)).is_none() {
            return Err("E_FORMAT_MENU_COMMAND_UNKNOWN");
        }
        let parsed = parse_accelerator(accelerator).ok_or("E_FORMAT_MENU_ACCELERATOR_INVALID")?;
        if seen.contains(&parsed) {
            return Err("E_FORMAT_MENU_ACCELERATOR_DUPLICATE");
        }
        if MENU_BAR_KEYS
            .iter()
            .any(|taken| parse_accelerator(taken) == Some(parsed))
        {
            return Err("E_FORMAT_MENU_ACCELERATOR_TAKEN");
        }
        seen.push(parsed);
    }
    Ok(items()
        .map(|item| (item.command, keys.get(item.command).cloned()))
        .collect())
}

#[tauri::command]
pub async fn format_menu_set(
    app: AppHandle,
    menu: State<'_, FormatMenu>,
    enabled: bool,
    keys: HashMap<String, String>,
) -> Result<(), String> {
    let plan = plan(&keys).map_err(String::from)?;
    // Every item is updated even when one fails, so the menu is never left
    // half on: a key left behind would shadow the window's own. Setting no
    // accelerator leaves an item's old key in place, so every key comes off
    // first and only the planned ones go back on.
    let mut failed = !clear_keys(&app).await;
    for (command, accelerator) in plan {
        let Some((_, item)) = menu.0.iter().find(|(c, _)| *c == command) else {
            continue;
        };
        failed |= item.set_enabled(enabled).is_err();
        failed |= item.set_accelerator(accelerator).is_err();
    }
    if failed {
        log::warn!("W_FORMAT_MENU_UPDATE_FAILED");
        return Err(String::from("E_FORMAT_MENU_UPDATE_FAILED"));
    }
    Ok(())
}

async fn clear_keys(app: &AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    {
        let (reply, answer) = tokio::sync::oneshot::channel();
        let sent = app.run_on_main_thread(move || {
            let _ = reply.send(crate::native::macos::clear_key_equivalents(
                strings::MENU_FORMAT,
            ));
        });
        sent.is_ok() && answer.await.unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_keys() -> HashMap<String, String> {
        serde_json::from_str(include_str!("../tests/fixtures/format-menu-keys.json"))
            .expect("a JSON object of strings")
    }

    #[test]
    fn lists_every_format_command_once() {
        let commands: Vec<_> = items().map(|item| item.command).collect();
        assert_eq!(
            commands,
            [
                "format.bold",
                "format.italic",
                "format.strikethrough",
                "format.highlight",
                "format.code",
                "format.link",
                "format.heading1",
                "format.heading2",
                "format.heading3",
                "format.heading4",
                "format.heading5",
                "format.heading6",
                "format.headingBigger",
                "format.headingSmaller",
                "format.codeBlock",
                "format.bulletList",
                "format.numberedList",
                "format.taskList",
                "format.quote",
                "format.alertNote",
                "format.alertTip",
                "format.alertImportant",
                "format.alertWarning",
                "format.alertCaution",
                "format.horizontalRule",
            ]
        );
    }

    #[test]
    fn groups_inline_formats_headings_blocks_and_alerts() {
        let shape: Vec<String> = FORMAT_MENU
            .iter()
            .map(|entry| match entry {
                Entry::Item(item) => item.label.to_owned(),
                Entry::Separator => String::from("---"),
                Entry::Submenu(label, items) => format!("{label} > {}", items.len()),
            })
            .collect();
        assert_eq!(
            shape,
            [
                "Bold",
                "Italic",
                "Strikethrough",
                "Highlight",
                "Inline Code",
                "Link",
                "---",
                "Heading > 8",
                "---",
                "Code Block",
                "Bulleted List",
                "Numbered List",
                "Task List",
                "Quote",
                "Alert > 5",
                "---",
                "Horizontal Rule",
            ]
        );
        let labels: Vec<_> = items().map(|item| item.label).collect();
        assert!(labels.contains(&"Heading 1") && labels.contains(&"Caution"));
    }

    #[test]
    fn knows_its_menu_ids() {
        for item in items() {
            assert_eq!(command_for(&menu_id(item.command)), Some(item.command));
        }
        assert_eq!(menu_id("format.italic"), "devot.format.italic");
        for other in [
            "devot.quit",
            "devot.history",
            "devot.format.nope",
            "format.bold",
            "devot.devot.format.bold",
            "",
        ] {
            assert_eq!(command_for(other), None, "{other}");
        }
    }

    #[test]
    fn takes_the_registry_keys() {
        let defaults = default_keys();
        assert!(defaults.len() > 10);
        let plan = plan(&defaults).expect("valid");
        assert_eq!(plan.len(), items().count());
        for (command, accelerator) in &plan {
            assert_eq!(accelerator.as_ref(), defaults.get(*command), "{command}");
        }
        let key = |command: &str| plan.iter().find(|(c, _)| *c == command).unwrap().1.clone();
        assert_eq!(key("format.italic").as_deref(), Some("CmdOrCtrl+I"));
        assert_eq!(key("format.strikethrough").as_deref(), Some("CmdOrCtrl+U"));
        assert_eq!(key("format.quote").as_deref(), Some("CmdOrCtrl+'"));
        assert_eq!(
            key("format.horizontalRule").as_deref(),
            Some("Shift+CmdOrCtrl+H")
        );
        assert_eq!(key("format.alertNote"), None);
        assert!(plan_all_none(&HashMap::new()));
    }

    fn plan_all_none(keys: &HashMap<String, String>) -> bool {
        plan(keys).expect("valid").iter().all(|(_, a)| a.is_none())
    }

    #[test]
    fn accepts_other_keys_of_the_registry_notation() {
        for accelerator in [
            "Ctrl+Shift+Alt+CmdOrCtrl+Z",
            "Ctrl+F5",
            "CmdOrCtrl+F12",
            "CmdOrCtrl+Backspace",
            "CmdOrCtrl+ArrowUp",
            "CmdOrCtrl+;",
            "CmdOrCtrl+\\",
            "CmdOrCtrl+`",
            "Alt+CmdOrCtrl+0",
        ] {
            let keys = HashMap::from([("format.bold".to_owned(), accelerator.to_owned())]);
            assert!(plan(&keys).is_ok(), "{accelerator}");
        }
    }

    #[test]
    fn refuses_unknown_commands() {
        for command in [
            "format.nope",
            "note.new",
            "palette.open",
            "",
            "devot.format.bold",
        ] {
            let keys = HashMap::from([(command.to_owned(), "CmdOrCtrl+B".to_owned())]);
            assert_eq!(
                plan(&keys),
                Err("E_FORMAT_MENU_COMMAND_UNKNOWN"),
                "{command}"
            );
        }
    }

    #[test]
    fn refuses_keys_that_are_not_accelerators_or_type_text() {
        for accelerator in [
            "",
            "I",
            "CmdOrCtrl",
            "CmdOrCtrl+",
            "Alt+I",
            "Shift+X",
            "Shift+Alt+8",
            "CmdOrCtrl+CmdOrCtrl+I",
            "Cmd+I",
            "Command+I",
            "CmdOrCtrl+i",
            "CmdOrCtrl+Ab",
            "CmdOrCtrl+F0",
            "CmdOrCtrl+F13",
            "CmdOrCtrl+F01",
            "CmdOrCtrl++",
            "+CmdOrCtrl+I",
            "CmdOrCtrl+\u{e9}",
            "CmdOrCtrl+I ",
            &format!("CmdOrCtrl+{}", "Shift+".repeat(20)),
        ] {
            let keys = HashMap::from([("format.bold".to_owned(), accelerator.to_owned())]);
            assert_eq!(
                plan(&keys),
                Err("E_FORMAT_MENU_ACCELERATOR_INVALID"),
                "{accelerator:?}"
            );
        }
    }

    #[test]
    fn refuses_keys_the_menu_bar_has() {
        for accelerator in [
            "CmdOrCtrl+C",
            "CmdOrCtrl+Q",
            "Shift+CmdOrCtrl+Z",
            "CmdOrCtrl+M",
        ] {
            let keys = HashMap::from([("format.code".to_owned(), accelerator.to_owned())]);
            assert_eq!(
                plan(&keys),
                Err("E_FORMAT_MENU_ACCELERATOR_TAKEN"),
                "{accelerator}"
            );
        }
        // Each is a valid accelerator, and every key menu.rs sets is listed,
        // except the defaults of the items that run a command (the UI sets
        // those; Synced Scrolling and Backups have none by default).
        for taken in MENU_BAR_KEYS {
            assert!(parse_accelerator(taken).is_some(), "{taken}");
        }
        let menu = include_str!("menu.rs");
        let others = menu
            .split(".accelerator(\"")
            .skip(1)
            .map(|part| part.split('"').next().unwrap_or_default())
            .filter(|accelerator| !MENU_BAR_KEYS.contains(accelerator))
            .count();
        assert_eq!(others, crate::menu::COMMAND_ITEMS.len() - 2);
        assert!(menu.matches(".accelerator(\"").count() >= 5);
    }

    #[test]
    fn refuses_one_key_for_two_formats() {
        let mut keys = default_keys();
        keys.insert("format.italic".to_owned(), "CmdOrCtrl+B".to_owned());
        assert_eq!(plan(&keys), Err("E_FORMAT_MENU_ACCELERATOR_DUPLICATE"));
        let mut keys = default_keys();
        keys.insert("format.italic".to_owned(), "CmdOrCtrl+Shift+L".to_owned());
        assert_eq!(plan(&keys), Err("E_FORMAT_MENU_ACCELERATOR_DUPLICATE"));
    }
}
