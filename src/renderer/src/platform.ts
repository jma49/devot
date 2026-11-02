/** Native menus and the updater exist only in the desktop app; Rust registers no command for them on a phone. */
export const hasDesktopShell = !['ios', 'android'].includes(
  import.meta.env.TAURI_ENV_PLATFORM as string,
)
