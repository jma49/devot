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

/**
 * The cleanup for a listener that is still being made: it stops the listener at once if it is
 * there, or as soon as `started` gives it. `failed` hears a listener that could not be made.
 */
export function unlistenLater(
  started: Promise<UnlistenFn>,
  failed?: (e: unknown) => void,
): () => void {
  let stopped = false
  let unlisten: UnlistenFn | undefined
  const kept = started.then((stop) => {
    if (stopped) stop()
    else unlisten = stop
  })
  if (failed) kept.catch(failed)
  return () => {
    stopped = true
    unlisten?.()
  }
}
