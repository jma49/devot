// Changes other processes make to the database while Devot runs, such as a
// note devot-mcp creates. Rust notices them (src-tauri/src/watch.rs) and
// sends `devot://db-changed`; the page re-sends it as a window event, which
// the UI tests can send too, merges the changes into the notes the core holds
// and reloads its lists (see App).
import { useEffect, useRef } from 'react'

export const DB_CHANGED = 'devot:db-changed'

export function useExternalChanges(onChange: (() => Promise<void>) | undefined) {
  const latest = useRef(onChange)
  const missed = useRef(false)
  useEffect(() => {
    latest.current = onChange
    if (onChange && missed.current) {
      missed.current = false
      window.dispatchEvent(new CustomEvent(DB_CHANGED))
    }
  }, [onChange])

  useEffect(() => {
    // Changes that arrive during a reload get one more reload after it.
    let running: Promise<void> | undefined
    let again = false
    const reload = () => {
      const run = latest.current
      if (!run) {
        missed.current = true
        return
      }
      if (running) {
        again = true
        return
      }
      running = run()
        .catch(() => console.warn('W_EXTERNAL_RELOAD_FAILED'))
        .finally(() => {
          running = undefined
          if (again) {
            again = false
            reload()
          }
        })
    }
    window.addEventListener(DB_CHANGED, reload)
    let stopped = false
    let unlisten: (() => void) | undefined
    if (!DEVOT_UI_TEST) {
      void import('@tauri-apps/api/event')
        .then(async ({ listen }) => {
          const stop = await listen('devot://db-changed', () =>
            window.dispatchEvent(new CustomEvent(DB_CHANGED)),
          )
          if (stopped) stop()
          else unlisten = stop
        })
        .catch(() => console.warn('W_EXTERNAL_LISTEN_FAILED'))
    }
    return () => {
      stopped = true
      window.removeEventListener(DB_CHANGED, reload)
      unlisten?.()
    }
  }, [])
}
