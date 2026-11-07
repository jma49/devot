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

/** Listeners still being made, for code that cleans up before they exist or chains work onto them. */
export interface Listening {
  /** Settles once the listeners are kept, or stopped for a cleanup that came first; rejects if they could not be made. */
  readonly ready: Promise<void>
  /** Whether the cleanup has run: work chained onto `ready` checks it before it acts. */
  readonly stopped: () => boolean
  readonly stop: () => void
}

export function keepListening(started: Promise<UnlistenFn | readonly UnlistenFn[]>): Listening {
  let stopped = false
  let kept: readonly UnlistenFn[] = []
  const ready = started.then((made) => {
    const stops = typeof made === 'function' ? [made] : made
    if (stopped) for (const stop of stops) stop()
    else kept = stops
  })
  return {
    ready,
    stopped: () => stopped,
    stop: () => {
      stopped = true
      for (const stop of kept) stop()
    },
  }
}

/**
 * The cleanup for listeners that are still being made: it stops them at once if they are there, or
 * as soon as `started` gives them. `failed` hears listeners that could not be made.
 */
export function unlistenLater(
  started: Promise<UnlistenFn | readonly UnlistenFn[]>,
  failed?: (e: unknown) => void,
): () => void {
  const listening = keepListening(started)
  if (failed) listening.ready.catch(failed)
  return listening.stop
}
