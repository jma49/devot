//! Settings > General > Language: the system's languages, or one the user picks for Devot alone.
//! The choice is the app's own `AppleLanguages` default (`native::app_languages`), so the system's
//! panels show it from the next launch and a choice made in System Settings > Language & Region >
//! Applications shows here too. Devot itself switches at once: the native text (`strings::show`),
//! the menus and window titles change in place, and every window hears `CHANGED_EVENT` and shows
//! the page in the new language; a window opened later starts in it (`initial_script`).

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::strings::{self, Language, Native, catalog_language};

pub const CHANGED_EVENT: &str = "devot://app-language-changed";
const INITIAL_GLOBAL: &str = "devotLanguage";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AppLanguage {
    #[serde(rename = "system")]
    System,
    #[serde(rename = "en")]
    English,
    #[serde(rename = "zh-Hans")]
    SimplifiedChinese,
}

impl AppLanguage {
    fn parse(choice: &str) -> Result<Self, &'static str> {
        match choice {
            "system" => Ok(Self::System),
            "en" => Ok(Self::English),
            "zh-Hans" => Ok(Self::SimplifiedChinese),
            _ => Err("E_APP_LANGUAGE_INVALID"),
        }
    }

    fn tags(self) -> Option<&'static [&'static str]> {
        match self {
            Self::System => None,
            Self::English => Some(&["en"]),
            Self::SimplifiedChinese => Some(&["zh-Hans"]),
        }
    }

    /// A list set elsewhere whose first language Devot does not ship counts as the system's.
    fn of(languages: Option<&[String]>) -> Self {
        match languages
            .and_then(|tags| tags.first())
            .and_then(|tag| catalog_language(tag))
        {
            Some(Language::English) => Self::English,
            Some(Language::SimplifiedChinese) => Self::SimplifiedChinese,
            None => Self::System,
        }
    }

    /// The language this choice shows, given the system's languages.
    fn shows<S: AsRef<str>>(self, system: &[S]) -> Language {
        match self {
            Self::System => strings::language_for(system),
            Self::English => Language::English,
            Self::SimplifiedChinese => Language::SimplifiedChinese,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct LanguageState {
    pub chosen: AppLanguage,
    /// The language every window shows now, as a tag the page's `resolveLocale` reads.
    pub shown: &'static str,
    /// False where Devot cannot set its own language (off macOS).
    pub available: bool,
}

fn stored() -> AppLanguage {
    AppLanguage::of(crate::native::app_languages().as_deref())
}

fn available() -> bool {
    cfg!(target_os = "macos")
}

fn state() -> LanguageState {
    LanguageState {
        chosen: stored(),
        shown: strings::shown().tag(),
        available: available(),
    }
}

/// Sets the page's language before it loads, where Devot picks it; elsewhere the page reads the
/// web view's languages.
pub fn initial_script() -> Option<String> {
    available().then(|| {
        format!(
            "window.{INITIAL_GLOBAL} = {};",
            serde_json::Value::from(strings::shown().tag())
        )
    })
}

#[tauri::command]
pub fn app_language_get() -> LanguageState {
    state()
}

#[tauri::command]
pub fn app_language_set(app: AppHandle, language: String) -> Result<LanguageState, String> {
    let language = AppLanguage::parse(&language)?;
    let before = strings::shown();
    if !crate::native::set_app_languages(language.tags()) {
        return Err("E_APP_LANGUAGE_UNAVAILABLE".into());
    }
    let after = language.shows(&crate::native::system_languages());
    log::info!("I_APP_LANGUAGE_SET {language:?} {after:?}");
    if strings::show(after) {
        relabel(&app, before.native(), after.native());
    }
    let next = state();
    if app.emit(CHANGED_EVENT, next).is_err() {
        log::warn!("W_APP_LANGUAGE_EMIT_FAILED");
    }
    Ok(next)
}

/// The menu bar, the menu bar icons and the window titles, from `from`'s text to `to`'s.
fn relabel(app: &AppHandle, from: &Native, to: &Native) {
    #[cfg(desktop)]
    {
        if let Some(menu) = app.menu()
            && relabel_items(menu.items(), from, to).is_err()
        {
            log::warn!("W_APP_LANGUAGE_MENU_FAILED");
        }
        crate::plugins::menu::refresh(app);
        crate::menu_bar::relabel(app);
        crate::background::relabel(app);
    }
    for window in app.webview_windows().into_values() {
        relabel_window(&window, from, to);
    }
}

#[cfg(desktop)]
fn relabel_items<R: Runtime>(
    items: tauri::Result<Vec<tauri::menu::MenuItemKind<R>>>,
    from: &Native,
    to: &Native,
) -> tauri::Result<()> {
    use tauri::menu::MenuItemKind;
    for item in items? {
        if item
            .id()
            .as_ref()
            .starts_with(crate::plugins::menu::ITEM_PREFIX)
        {
            continue;
        }
        let swap =
            |text: tauri::Result<String>| text.map(|text| strings::translate(&text, from, to));
        match &item {
            MenuItemKind::Submenu(submenu) => {
                if let Some(text) = swap(submenu.text())? {
                    submenu.set_text(text)?;
                }
                relabel_items(submenu.items(), from, to)?;
            }
            MenuItemKind::MenuItem(it) => {
                if let Some(text) = swap(it.text())? {
                    it.set_text(text)?;
                }
            }
            MenuItemKind::Check(it) => {
                if let Some(text) = swap(it.text())? {
                    it.set_text(text)?;
                }
            }
            MenuItemKind::Predefined(it) => {
                if let Some(text) = swap(it.text())? {
                    it.set_text(text)?;
                }
            }
            MenuItemKind::Icon(it) => {
                if let Some(text) = swap(it.text())? {
                    it.set_text(text)?;
                }
            }
        }
    }
    Ok(())
}

/// Only the titles Devot gives its own windows: a note window's title is the note's.
fn window_title(title: &str, from: &Native, to: &Native) -> Option<&'static str> {
    let ours = |text: fn(&Native) -> &'static str| (title == text(from)).then(|| text(to));
    ours(|n| n.settings_title)
        .or_else(|| ours(|n| n.quick_capture_title))
        .or_else(|| ours(|n| n.note_window_title))
}

fn relabel_window<R: Runtime>(window: &tauri::WebviewWindow<R>, from: &Native, to: &Native) {
    let Ok(title) = window.title() else {
        return;
    };
    if let Some(text) = window_title(&title, from, to)
        && window.set_title(text).is_err()
    {
        log::warn!("W_APP_LANGUAGE_TITLE_FAILED");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags(list: &[&str]) -> Vec<String> {
        list.iter().map(|tag| (*tag).to_owned()).collect()
    }

    #[test]
    fn only_the_three_choices_parse() {
        assert_eq!(AppLanguage::parse("system"), Ok(AppLanguage::System));
        assert_eq!(AppLanguage::parse("en"), Ok(AppLanguage::English));
        assert_eq!(
            AppLanguage::parse("zh-Hans"),
            Ok(AppLanguage::SimplifiedChinese)
        );
        for other in ["", "EN", "zh", "zh-Hant", "fr", "system "] {
            assert_eq!(AppLanguage::parse(other), Err("E_APP_LANGUAGE_INVALID"));
        }
    }

    #[test]
    fn each_choice_writes_the_tags_it_reads_back() {
        for choice in [
            AppLanguage::System,
            AppLanguage::English,
            AppLanguage::SimplifiedChinese,
        ] {
            let written = choice.tags().map(tags);
            assert_eq!(AppLanguage::of(written.as_deref()), choice);
        }
    }

    #[test]
    fn a_list_set_in_system_settings_reads_by_its_first_language() {
        assert_eq!(AppLanguage::of(None), AppLanguage::System);
        assert_eq!(AppLanguage::of(Some(&[])), AppLanguage::System);
        assert_eq!(
            AppLanguage::of(Some(&tags(&["zh-Hans-CN", "en"]))),
            AppLanguage::SimplifiedChinese
        );
        assert_eq!(
            AppLanguage::of(Some(&tags(&["en-GB"]))),
            AppLanguage::English
        );
        assert_eq!(
            AppLanguage::of(Some(&tags(&["zh-Hant", "en"]))),
            AppLanguage::System
        );
        assert_eq!(AppLanguage::of(Some(&tags(&["fr"]))), AppLanguage::System);
    }

    #[test]
    fn the_page_reads_the_choice_by_its_tag() {
        let json = serde_json::to_value(LanguageState {
            chosen: AppLanguage::SimplifiedChinese,
            shown: Language::SimplifiedChinese.tag(),
            available: true,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "chosen": "zh-Hans", "shown": "zh-Hans", "available": true })
        );
    }

    #[test]
    fn same_as_system_shows_the_system_language_and_a_pick_shows_itself() {
        let chinese_system = tags(&["zh-Hans-CN", "en"]);
        assert_eq!(
            AppLanguage::System.shows(&chinese_system),
            Language::SimplifiedChinese
        );
        assert_eq!(AppLanguage::System.shows(&tags(&["fr"])), Language::English);
        assert_eq!(
            AppLanguage::English.shows(&chinese_system),
            Language::English
        );
        assert_eq!(
            AppLanguage::SimplifiedChinese.shows(&tags(&["en"])),
            Language::SimplifiedChinese
        );
    }

    #[test]
    fn every_shown_tag_reads_back_as_its_choice() {
        for language in [Language::English, Language::SimplifiedChinese] {
            assert_eq!(catalog_language(language.tag()), Some(language));
        }
    }

    #[test]
    fn only_devots_own_window_titles_change_language() {
        let (en, zh) = (
            Language::English.native(),
            Language::SimplifiedChinese.native(),
        );
        assert_eq!(
            window_title(en.settings_title, en, zh),
            Some(zh.settings_title)
        );
        assert_eq!(
            window_title(zh.quick_capture_title, zh, en),
            Some(en.quick_capture_title)
        );
        assert_eq!(window_title(en.menu_file, en, zh), None);
        assert_eq!(window_title("Devot", en, zh), None);
    }
}
