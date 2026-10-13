//! The sidebar material (Settings > Appearance > Translucent sidebar). The
//! main window is transparent and draws the system `sidebar` material behind
//! the web view (`windowEffects` in `tauri.conf.json`); the sidebar shows it
//! through a light tint. Turned off, the window drops the effect and the
//! sidebar paints an opaque surface instead, so the window is opaque.
//!
//! The setting lives with the editor settings (`editor_settings`). The main
//! window is built with the effect only when it is on; after a change the
//! main window's page calls `sidebar_material_sync`, which removes or
//! restores the effect at once, without a restart. Tauri's `set_effects`
//! does the AppKit work on the main thread.

use crate::MAIN_WINDOW;
use crate::editor_settings::{EditorSettingsStore, Snapshot};
use std::sync::{Arc, Mutex};
use tauri::utils::config::WindowEffectsConfig;
use tauri::{AppHandle, Manager, State};

/// The main window's effects: the configured ones (the `sidebar` material)
/// when the material is on, none when it is off.
pub fn effects_for(
    material: bool,
    configured: Option<&WindowEffectsConfig>,
) -> Option<WindowEffectsConfig> {
    if material { configured.cloned() } else { None }
}

/// What the main window shows: the material on or off, as of a settings
/// revision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Shown {
    pub revision: u64,
    pub material: bool,
}

impl Shown {
    /// The material to apply for settings stored at `revision`, or `None`
    /// when the window stays as it is: settings older than the ones shown
    /// are ignored (two changes can finish out of order), and a change to
    /// another setting leaves the window alone.
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

/// The main window's material, kept in step with the stored setting.
pub struct SidebarMaterial {
    configured: Option<WindowEffectsConfig>,
    shown: Mutex<Shown>,
}

impl SidebarMaterial {
    /// `configured` is the window's effect from the config; `start` is what
    /// the window was built with.
    pub fn new(configured: Option<WindowEffectsConfig>, start: Shown) -> Self {
        Self {
            configured,
            shown: Mutex::new(start),
        }
    }

    /// Removes or restores the main window's effect when the stored settings
    /// changed the material; returns the material the window now shows. The
    /// effect is changed under the lock, so the main thread receives the
    /// changes in revision order.
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
        // only when the window is gone or the queue is closed.
        let queued = app
            .get_webview_window(MAIN_WINDOW)
            .ok_or("E_SIDEBAR_MATERIAL_NO_WINDOW")
            .and_then(|window| {
                window
                    .set_effects(effects_for(material, self.configured.as_ref()))
                    .map_err(|_| "E_SIDEBAR_MATERIAL_APPLY_FAILED")
            });
        if let Err(code) = queued {
            // Still what it was: the next change (a newer revision) tries again.
            shown.material = before.material;
            return Err(code);
        }
        Ok(material)
    }
}

/// Brings the main window's effect in line with the stored sidebar material
/// (main window only; no arguments). The page calls it after a change: when
/// the material goes off, once its sidebar is painted opaque, and when it
/// comes back, before its sidebar turns translucent, so the window never
/// shows the desktop through a bare tint. It returns once the main thread has
/// applied the change, with the material the window shows.
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
            .find(|w| w.label == MAIN_WINDOW)
            .and_then(|w| w.window_effects)
            .expect("the main window has an effect")
    }

    #[test]
    fn the_main_window_is_configured_with_the_sidebar_material() {
        let effects = configured();
        assert_eq!(effects.effects, vec![Effect::Sidebar]);
        assert_eq!(effects.state, Some(EffectState::FollowsWindowActiveState));
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
        // The same revision twice changes nothing either.
        assert_eq!(shown.follow(2, false), None);
        assert!(shown.material);
    }
}
