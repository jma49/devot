// What the Settings window asks of Rust beyond the settings themselves
// (src-tauri/src/settings.rs): fitting the window to the pane it shows,
// opening the app's data folder in Finder and showing the Backups dialog.
import { invoke } from '../ipc'

/**
 * Makes the window's content area `height` points tall (its top edge
 * staying put), animated for a pane change. A window that cannot be fitted
 * keeps its size, and the pane scrolls.
 */
export function fitWindow(height: number, animate: boolean): Promise<void> {
  return invoke('settings_fit', { height, animate })
}

/** Shows the folder Devot keeps its data in, in Finder. */
export function openDataFolder(): Promise<void> {
  return invoke('settings_open_data_folder')
}

/** Brings the main window to the front with its Backups dialog. */
export function showBackups(): Promise<void> {
  return invoke('settings_show_backups')
}
