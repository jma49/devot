// When this window last saved a note: the sidebar's footer shows it. A
// module-level store, so a save re-renders only the footer, not the sidebar
// or the window around it.
import { useSyncExternalStore } from 'react'

let at: number | null = null
const listeners = new Set<() => void>()

/** Records a write at `time` (ms since the epoch); an older time changes nothing. */
export function markWrite(time: number): void {
  if (at !== null && time <= at) return
  at = time
  listeners.forEach((listener) => listener())
}

/** The time of the last write, or null before any. */
export const lastWrite = (): number | null => at

/** The time of the last write, re-rendering when it changes. */
export function useLastWrite(): number | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => at,
    () => at,
  )
}

/** `HH:MM:SS` on the local clock. */
export function clockTime(time: number): string {
  const d = new Date(time)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}
