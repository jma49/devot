//! The editor's context menu: its items, spelling guesses, Writing Tools and Services.

use std::cell::Cell;

use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Sel};
use objc2::sel;
use objc2::{ClassType, MainThreadMarker, MainThreadOnly, define_class};
use objc2_app_kit::{
    NSApplication, NSControlStateValueOn, NSEventModifierFlags, NSMenu, NSMenuItem, NSSpellChecker,
    NSView,
};
use objc2_foundation::{NSObject, NSObjectProtocol, NSPoint, NSString};

use crate::native::{
    EditorMenuEntry, EditorMenuPick, KeyEquivalent, SystemItem, guarded, key_equivalent,
};
use crate::strings;

use super::responds;

const MAX_SPELLING_GUESSES: usize = 8;

enum MenuChoice {
    Item(String),
    Guess(String),
    Learn,
}

thread_local! {
    static EDITOR_MENU_PICK: Cell<Option<isize>> = const { Cell::new(None) };
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and
    // `EditorMenuTarget` implements no `Drop`.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "DevotEditorMenuTarget"]
    struct EditorMenuTarget;

    // SAFETY: NSObjectProtocol has no requirements beyond NSObject's.
    unsafe impl NSObjectProtocol for EditorMenuTarget {}

    impl EditorMenuTarget {
        #[unsafe(method(pick:))]
        fn pick(&self, sender: &NSMenuItem) {
            EDITOR_MENU_PICK.with(|pick| pick.set(Some(sender.tag())));
        }
    }
);

struct EditorMenuBuilder<'a> {
    mtm: MainThreadMarker,
    target: &'a EditorMenuTarget,
    choices: Vec<MenuChoice>,
}

impl EditorMenuBuilder<'_> {
    fn item(&self, title: &str, action: Option<Sel>, key: &str) -> Retained<NSMenuItem> {
        // SAFETY: a fresh allocation; the title, action and key are valid.
        unsafe {
            NSMenuItem::initWithTitle_action_keyEquivalent(
                self.mtm.alloc(),
                &NSString::from_str(title),
                action,
                &NSString::from_str(key),
            )
        }
    }

    fn choice(&mut self, title: &str, choice: MenuChoice) -> Retained<NSMenuItem> {
        let item = self.item(title, Some(sel!(pick:)), "");
        item.setTag(self.choices.len() as isize);
        // SAFETY: the target answers `pick:` and outlives the menu: the
        // caller keeps it until the menu has closed.
        unsafe { item.setTarget(Some(self.target)) };
        self.choices.push(choice);
        item
    }

    fn separator(&self) -> Retained<NSMenuItem> {
        NSMenuItem::separatorItem(self.mtm)
    }

    fn add_entries(&mut self, menu: &NSMenu, entries: &[EditorMenuEntry]) {
        for entry in entries {
            match entry {
                EditorMenuEntry::Separator => menu.addItem(&self.separator()),
                EditorMenuEntry::Predefined { item } => {
                    let (title, action, key) = match item {
                        SystemItem::Cut => (strings::EDIT_CUT, sel!(cut:), "x"),
                        SystemItem::Copy => (strings::EDIT_COPY, sel!(copy:), "c"),
                        SystemItem::Paste => (strings::EDIT_PASTE, sel!(paste:), "v"),
                        SystemItem::SelectAll => (strings::EDIT_SELECT_ALL, sel!(selectAll:), "a"),
                    };
                    menu.addItem(&self.item(title, Some(action), key));
                }
                EditorMenuEntry::Item {
                    id,
                    text,
                    accelerator,
                    checked,
                } => {
                    let item = self.choice(text, MenuChoice::Item(id.clone()));
                    if let Some(key) = accelerator.as_deref().and_then(key_equivalent) {
                        item.setKeyEquivalent(&NSString::from_str(&key.key));
                        item.setKeyEquivalentModifierMask(modifier_flags(&key));
                    }
                    if *checked == Some(true) {
                        item.setState(NSControlStateValueOn);
                    }
                    menu.addItem(&item);
                }
                EditorMenuEntry::Submenu { text, items, .. } => {
                    let item = self.item(text, None, "");
                    let submenu = NSMenu::new(self.mtm);
                    self.add_entries(&submenu, items);
                    item.setSubmenu(Some(&submenu));
                    menu.addItem(&item);
                }
            }
        }
    }

    fn add_spelling_guesses(&mut self, menu: &NSMenu, word: &str) {
        let Some(guesses) = spelling_guesses(word) else {
            return;
        };
        if guesses.is_empty() {
            menu.addItem(&self.item(strings::SPELLING_NO_GUESSES, None, ""));
        }
        for guess in guesses {
            let item = self.choice(&guess, MenuChoice::Guess(guess.clone()));
            menu.addItem(&item);
        }
        menu.addItem(&self.separator());
        let learn = self.choice(strings::SPELLING_LEARN, MenuChoice::Learn);
        menu.addItem(&learn);
        menu.addItem(&self.separator());
    }

    fn spelling_menu(&self) -> Retained<NSMenuItem> {
        let submenu = NSMenu::new(self.mtm);
        submenu.addItem(&self.item(
            strings::SPELLING_SHOW_PANEL,
            Some(sel!(showGuessPanel:)),
            "",
        ));
        submenu.addItem(&self.item(strings::SPELLING_CHECK_NOW, Some(sel!(checkSpelling:)), ""));
        submenu.addItem(&self.separator());
        for (title, action) in [
            (
                strings::SPELLING_WHILE_TYPING,
                sel!(toggleContinuousSpellChecking:),
            ),
            (strings::SPELLING_GRAMMAR, sel!(toggleGrammarChecking:)),
            (
                strings::SPELLING_CORRECT_AUTOMATICALLY,
                sel!(toggleAutomaticSpellingCorrection:),
            ),
        ] {
            submenu.addItem(&self.item(title, Some(action), ""));
        }
        let item = self.item(strings::MENU_SPELLING, None, "");
        item.setSubmenu(Some(&submenu));
        item
    }
}

fn modifier_flags(key: &KeyEquivalent) -> NSEventModifierFlags {
    let mut flags = NSEventModifierFlags::empty();
    for (on, flag) in [
        (key.command, NSEventModifierFlags::Command),
        (key.shift, NSEventModifierFlags::Shift),
        (key.option, NSEventModifierFlags::Option),
        (key.control, NSEventModifierFlags::Control),
    ] {
        if on {
            flags |= flag;
        }
    }
    flags
}

fn spelling_guesses(word: &str) -> Option<Vec<String>> {
    let checker = NSSpellChecker::sharedSpellChecker();
    let string = NSString::from_str(word);
    let range = checker.checkSpellingOfString_startingAt(&string, 0);
    if range.length == 0 {
        return None;
    }
    let guesses = checker
        .guessesForWordRange_inString_language_inSpellDocumentWithTag(range, &string, None, 0);
    Some(
        guesses
            .map(|guesses| {
                guesses
                    .to_vec()
                    .iter()
                    .take(MAX_SPELLING_GUESSES)
                    .map(|guess| guess.to_string())
                    .collect()
            })
            .unwrap_or_default(),
    )
}

pub fn editor_menu(
    webview: &tauri::webview::PlatformWebview,
    entries: &[EditorMenuEntry],
    x: f64,
    y: f64,
    word: Option<&str>,
) -> Result<Option<EditorMenuPick>, &'static str> {
    let web_view: *mut AnyObject = webview.inner().cast();
    guarded("W_NATIVE_EDITOR_MENU_FAILED", || {
        let mtm = MainThreadMarker::new()?;
        // SAFETY: `inner()` is the live WKWebView owned by the window (an
        // NSView); the call runs on the main thread (`with_webview`).
        let view = unsafe { web_view.cast::<NSView>().as_ref() }?;
        Some(show_editor_menu(mtm, view, entries, x, y, word))
    })
    .unwrap_or(Err("E_EDITOR_MENU_FAILED"))
}

fn build_editor_menu(
    builder: &mut EditorMenuBuilder<'_>,
    entries: &[EditorMenuEntry],
    word: Option<&str>,
) -> (Retained<NSMenu>, Retained<NSMenu>) {
    let mtm = builder.mtm;
    let menu = NSMenu::new(mtm);
    if let Some(word) = word {
        builder.add_spelling_guesses(&menu, word);
    }
    builder.add_entries(&menu, entries);
    menu.addItem(&builder.separator());
    let class = (NSMenuItem::class() as *const AnyClass)
        .cast_mut()
        .cast::<AnyObject>();
    // SAFETY: the class object is a live NSObject class; asking it answers
    // whether the class method exists on this system.
    if unsafe { responds(class, sel!(writingToolsItems)) } {
        for item in NSMenuItem::writingToolsItems(mtm).to_vec() {
            menu.addItem(&item);
        }
    } else {
        log::warn!("W_NATIVE_WRITING_TOOLS_UNAVAILABLE");
    }
    menu.addItem(&builder.spelling_menu());
    menu.addItem(&builder.separator());
    let services = NSMenu::new(mtm);
    let services_item = builder.item(strings::MENU_SERVICES, None, "");
    services_item.setSubmenu(Some(&services));
    menu.addItem(&services_item);
    (menu, services)
}

/// Puts the app's own Services menu back when dropped, so it comes back
/// however the editor's menu ended (an exception unwinds through it too).
struct RestoreServices {
    app: Retained<NSApplication>,
    menu: Option<Retained<NSMenu>>,
}

impl Drop for RestoreServices {
    fn drop(&mut self) {
        self.app.setServicesMenu(self.menu.as_deref());
    }
}

fn picked_choice(choices: &[MenuChoice]) -> Option<&MenuChoice> {
    EDITOR_MENU_PICK
        .with(Cell::take)
        .and_then(|tag| usize::try_from(tag).ok())
        .and_then(|index| choices.get(index))
}

fn show_editor_menu(
    mtm: MainThreadMarker,
    view: &NSView,
    entries: &[EditorMenuEntry],
    x: f64,
    y: f64,
    word: Option<&str>,
) -> Result<Option<EditorMenuPick>, &'static str> {
    let target = EditorMenuTarget::alloc(mtm).set_ivars(());
    // SAFETY: NSObject's `init` on a freshly allocated subclass instance.
    let target: Retained<EditorMenuTarget> = unsafe { msg_send![super(target), init] };
    let mut builder = EditorMenuBuilder {
        mtm,
        target: &target,
        choices: Vec::new(),
    };
    let (menu, services) = build_editor_menu(&mut builder, entries, word);
    // AppKit fills the app's Services menu with what the first responder's
    // selection can be sent to: this one for as long as the menu is open.
    let app = NSApplication::sharedApplication(mtm);
    let restore = RestoreServices {
        menu: app.servicesMenu(),
        app: app.clone(),
    };
    app.setServicesMenu(Some(&services));
    EDITOR_MENU_PICK.with(|pick| pick.set(None));
    // The item picked has sent its action by the time this returns.
    menu.popUpMenuPositioningItem_atLocation_inView(None, NSPoint::new(x, y), Some(view));
    drop(restore);
    Ok(match picked_choice(&builder.choices) {
        None => None,
        Some(MenuChoice::Item(id)) => Some(EditorMenuPick::Item { id: id.clone() }),
        Some(MenuChoice::Guess(text)) => Some(EditorMenuPick::Guess { text: text.clone() }),
        Some(MenuChoice::Learn) => {
            if let Some(word) = word {
                NSSpellChecker::sharedSpellChecker().learnWord(&NSString::from_str(word));
            }
            None
        }
    })
}

pub fn self_test_editor_menu() -> Result<(), &'static str> {
    let mtm = MainThreadMarker::new().ok_or("E_TEST_NOT_MAIN_THREAD")?;
    let target = EditorMenuTarget::alloc(mtm).set_ivars(());
    // SAFETY: NSObject's `init` on a freshly allocated subclass instance.
    let target: Retained<EditorMenuTarget> = unsafe { msg_send![super(target), init] };
    let entries = [
        EditorMenuEntry::Item {
            id: "devot.editor.undo".into(),
            text: "Undo".into(),
            accelerator: Some("CmdOrCtrl+Z".into()),
            checked: None,
        },
        EditorMenuEntry::Separator,
        EditorMenuEntry::Predefined {
            item: SystemItem::Cut,
        },
    ];
    let titles = |menu: &NSMenu| -> Vec<String> {
        menu.itemArray()
            .to_vec()
            .iter()
            .map(|item| item.title().to_string())
            .collect()
    };
    // A cold spell server (a loaded CI runner) times out its first checks and finds no misspelling.
    let answering = (0..20).any(|_| {
        let found = spelling_guesses("recieve").is_some();
        if !found {
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        found
    });
    if !answering {
        return Err("E_TEST_SPELL_SERVER_SILENT");
    }
    let mut builder = EditorMenuBuilder {
        mtm,
        target: &target,
        choices: Vec::new(),
    };
    let (menu, _) = build_editor_menu(&mut builder, &entries, Some("recieve"));
    let shown = titles(&menu);
    let undo = shown
        .iter()
        .position(|t| t == "Undo")
        .ok_or("E_TEST_NO_UNDO")?;
    let learn = shown
        .iter()
        .position(|t| t == strings::SPELLING_LEARN)
        .ok_or("E_TEST_NO_LEARN")?;
    if !shown[..learn].iter().any(|t| t == "receive") || learn > undo {
        return Err("E_TEST_NO_GUESS");
    }
    for title in [
        strings::EDIT_CUT,
        strings::MENU_SPELLING,
        strings::MENU_SERVICES,
    ] {
        if !shown.iter().any(|t| t == title) {
            return Err("E_TEST_SYSTEM_ITEM_MISSING");
        }
    }
    if shown.last().map(String::as_str) != Some(strings::MENU_SERVICES) {
        return Err("E_TEST_SERVICES_NOT_LAST");
    }
    let undo_item = menu.itemAtIndex(undo as isize).ok_or("E_TEST_NO_UNDO")?;
    if undo_item.keyEquivalent().to_string() != "z"
        || !undo_item
            .keyEquivalentModifierMask()
            .contains(NSEventModifierFlags::Command)
    {
        return Err("E_TEST_UNDO_KEY");
    }
    menu.performActionForItemAtIndex(undo as isize);
    match picked_choice(&builder.choices) {
        Some(MenuChoice::Item(id)) if id == "devot.editor.undo" => {}
        _ => return Err("E_TEST_PICK_LOST"),
    }
    let mut builder = EditorMenuBuilder {
        mtm,
        target: &target,
        choices: Vec::new(),
    };
    let (menu, _) = build_editor_menu(&mut builder, &entries, Some("the"));
    if titles(&menu).first().map(String::as_str) != Some("Undo") {
        return Err("E_TEST_GUESSES_FOR_A_RIGHT_WORD");
    }
    Ok(())
}
