// What the Settings window asks of Rust beyond the settings themselves
// (src-tauri/src/settings.rs): opening the app's data folder in Finder and
// showing the Backups dialog.
import { invoke } from '../ipc'

/** Shows the folder Devot keeps its data in, in Finder. */
export function openDataFolder(): Promise<void> {
  return invoke('settings_open_data_folder')
}

/** Brings the main window to the front with its Backups dialog. */
export function showBackups(): Promise<void> {
  return invoke('settings_show_backups')
}
