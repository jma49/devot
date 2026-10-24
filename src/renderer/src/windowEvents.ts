import type { Event, UnlistenFn } from '@tauri-apps/api/event'

/**
 * Listens to an event Rust sent to this window with `emit_to` (the frontmost main window, say). The
 * event module's `listen` hears the events sent to any window, which would run a menu item, a deep
 * link or an import in every main window; this one hears what is sent to this window only.
 */
export async function listenHere<T>(
  event: string,
  handler: (event: Event<T>) => void,
): Promise<UnlistenFn> {
  const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow')
  return getCurrentWebviewWindow().listen<T>(event, handler)
}
