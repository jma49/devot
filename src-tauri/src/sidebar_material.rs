//! The window material (Settings > Appearance > Translucent window). Each main window is transparent
//! and draws the system under-window material behind the whole web view (`windowEffects` in
//! `tauri.conf.json`); the regions show it through their own washes. Turned off, the window drops
//! the effect and the page paints every region opaque.
//! The setting lives with the editor settings (`sidebarMaterial`). After a change the page calls
//! `sidebar_material_sync`, which removes or restores the effect without a restart.

use crate::editor_settings::{EditorSettingsStore, Snapshot};
use std::sync::{Arc, Mutex};
use tauri::utils::config::WindowEffectsConfig;
use tauri::{AppHandle, Manager, State};

pub fn effects_for(
    material: bool,
    configured: Option<&WindowEffectsConfig>,
) -> Option<WindowEffectsConfig> {
    if material { configured.cloned() } else { None }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Shown {
    pub revision: u64,
    pub material: bool,
}

impl Shown {
    /// Settings older than the ones shown are ignored (two changes can finish out of order), and a
    /// change to another setting leaves the window alone.
    pub fn follow(&mut self, revision: u64, material: bool) -> Option<bool> {
        if revision <= self.revision {
            return None;
        }
        self.revision = revision;
        if material == self.material {
            return None;
        }
        self.material = material;
        Some(material)
    }
}

pub struct SidebarMaterial {
    configured: Option<WindowEffectsConfig>,
    shown: Mutex<Shown>,
}

impl SidebarMaterial {
    /// The effect a main window opens with: as the setting is now.
    pub fn effects(&self) -> Option<WindowEffectsConfig> {
        let material = self
            .shown
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .material;
        effects_for(material, self.configured.as_ref())
    }

    pub fn new(configured: Option<WindowEffectsConfig>, start: Shown) -> Self {
        Self {
            configured,
            shown: Mutex::new(start),
        }
    }

    /// The effect is changed under the lock, so the main thread receives the changes in revision
    /// order.
    fn follow(&self, app: &AppHandle, stored: &Snapshot) -> Result<bool, &'static str> {
        let mut shown = self
            .shown
            .lock()
            .map_err(|_| "E_SIDEBAR_MATERIAL_LOCK_FAILED")?;
        let before = *shown;
        let Some(material) = shown.follow(stored.revision, stored.settings.sidebar_material) else {
            return Ok(shown.material);
        };
        // Tauri queues the change on the main thread (AppKit); this fails
        // only when a window is gone or the queue is closed.
        let windows: Vec<_> = app
            .webview_windows()
            .into_iter()
            .filter(|(label, _)| crate::main_windows::is_main(label))
            .map(|(_, window)| window)
            .collect();
        let queued = if windows.is_empty() {
            Err("E_SIDEBAR_MATERIAL_NO_WINDOW")
        } else {
            #[cfg(desktop)]
            {
                windows.iter().try_for_each(|window| {
                    window
                        .set_effects(effects_for(material, self.configured.as_ref()))
                        .map_err(|_| "E_SIDEBAR_MATERIAL_APPLY_FAILED")
                })
            }
            #[cfg(mobile)]
            Ok(())
        };
        if let Err(code) = queued {
            // Still what it was: the next change (a newer revision) tries again.
            shown.material = before.material;
            return Err(code);
        }
        Ok(material)
    }
}

/// Brings every main window's effect in line with the stored setting. The page calls it when the
/// material goes off once its regions are painted opaque, and when it comes back before they turn
/// translucent, so the window never shows the desktop through a bare wash.
#[tauri::command]
pub async fn sidebar_material_sync(
    app: AppHandle,
    store: State<'_, Arc<EditorSettingsStore>>,
    material: State<'_, SidebarMaterial>,
) -> Result<bool, String> {
    let stored = store.get().map_err(String::from)?;
    let shown = material.follow(&app, &stored).map_err(|code| {
        log::warn!("W_SIDEBAR_MATERIAL_SYNC_FAILED {code}");
        String::from(code)
    })?;
    // The main thread runs its queue in order: once this has run, so has
    // the effect change queued above.
    let (reply, applied) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = reply.send(());
    })
    .map_err(|_| String::from("E_NATIVE_MAIN_THREAD_UNAVAILABLE"))?;
    applied
        .await
        .map_err(|_| String::from("E_SIDEBAR_MATERIAL_APPLY_FAILED"))?;
    Ok(shown)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::utils::config::Config;
    use tauri::window::{Effect, EffectState};

    fn configured() -> WindowEffectsConfig {
        let config: Config =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("config parses");
        config
            .app
            .windows
            .into_iter()
            .find(|w| w.label == crate::MAIN_WINDOW)
            .and_then(|w| w.window_effects)
            .expect("the main window has an effect")
    }

    #[test]
    fn the_main_window_is_configured_with_the_under_window_material() {
        let effects = configured();
        assert_eq!(effects.effects, vec![Effect::UnderWindowBackground]);
        // Active also while the window is inactive, so it never turns grey.
        assert_eq!(effects.state, Some(EffectState::Active));
    }

    #[test]
    fn the_material_on_keeps_the_configured_effect_and_off_drops_it() {
        let effects = configured();
        assert_eq!(effects_for(true, Some(&effects)), Some(effects.clone()));
        assert_eq!(effects_for(false, Some(&effects)), None);
        assert_eq!(effects_for(true, None), None);
    }

    #[test]
    fn follows_a_change_of_the_material() {
        let mut shown = Shown {
            revision: 0,
            material: true,
        };
        assert_eq!(shown.follow(1, false), Some(false));
        assert_eq!(
            shown,
            Shown {
                revision: 1,
                material: false
            }
        );
        assert_eq!(shown.follow(2, true), Some(true));
        assert!(shown.material);
    }

    #[test]
    fn leaves_the_window_alone_when_another_setting_changes() {
        let mut shown = Shown {
            revision: 3,
            material: false,
        };
        assert_eq!(shown.follow(4, false), None);
        assert_eq!(shown.revision, 4);
        assert!(!shown.material);
    }

    #[test]
    fn ignores_settings_older_than_the_ones_shown() {
        let mut shown = Shown {
            revision: 0,
            material: true,
        };
        // Revision 2 (on, after an off) finished before revision 1 (off).
        assert_eq!(shown.follow(2, true), None);
        assert_eq!(shown.follow(1, false), None);
        assert!(shown.material);
        assert_eq!(shown.follow(2, false), None);
        assert!(shown.material);
    }
}
