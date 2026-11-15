//! Settings > General > Language: the system's languages, or one the user picks for Devot alone.
//! The choice is the app's own `AppleLanguages` default (`native::app_languages`), so the page, the
//! native menus and the system's panels all show it from the next launch, and a choice made in
//! System Settings > Language & Region > Applications shows here too.

use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::strings::{Language, catalog_language};

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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct LanguageState {
    pub chosen: AppLanguage,
    /// What this run shows; Settings offers a restart while the two differ.
    pub running: AppLanguage,
    /// False where Devot cannot set its own language (off macOS).
    pub available: bool,
}

static RUNNING: OnceLock<AppLanguage> = OnceLock::new();
static RESTART: AtomicBool = AtomicBool::new(false);

fn stored() -> AppLanguage {
    AppLanguage::of(crate::native::app_languages().as_deref())
}

/// Read at the first ask, before any change this run makes.
fn running() -> AppLanguage {
    *RUNNING.get_or_init(stored)
}

fn available() -> bool {
    cfg!(target_os = "macos")
}

fn state() -> LanguageState {
    LanguageState {
        chosen: stored(),
        running: running(),
        available: available(),
    }
}

#[tauri::command]
pub fn app_language_get() -> LanguageState {
    state()
}

#[tauri::command]
pub fn app_language_set(language: String) -> Result<LanguageState, String> {
    let language = AppLanguage::parse(&language)?;
    running();
    if !crate::native::set_app_languages(language.tags()) {
        return Err("E_APP_LANGUAGE_UNAVAILABLE".into());
    }
    log::info!("I_APP_LANGUAGE_SET {language:?}");
    Ok(state())
}

/// Quits as Quit does, every window saving first, then launches again.
#[tauri::command]
pub fn app_language_restart(app: AppHandle) -> Result<(), String> {
    if !available() {
        return Err("E_APP_LANGUAGE_UNAVAILABLE".into());
    }
    RESTART.store(true, Ordering::SeqCst);
    log::info!("I_APP_LANGUAGE_RESTART");
    crate::exit::request_quit(&app);
    Ok(())
}

/// Whether the exit under way was asked for by Restart Now.
pub fn on_exit() -> bool {
    RESTART.load(Ordering::SeqCst)
}

/// The quit was called off (a note could not be saved): exiting later does not restart.
pub fn restart_called_off() {
    RESTART.store(false, Ordering::SeqCst);
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
            running: AppLanguage::System,
            available: true,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "chosen": "zh-Hans", "running": "system", "available": true })
        );
    }

    #[test]
    fn a_called_off_quit_does_not_restart() {
        RESTART.store(true, Ordering::SeqCst);
        restart_called_off();
        assert!(!on_exit());
    }
}
