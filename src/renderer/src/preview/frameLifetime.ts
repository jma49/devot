/** How long the diagram frame stays once no diagram is shown and no drawing is asked for. */
export const FRAME_IDLE_MS = 30_000

/**
 * When to close a frame that costs memory while it stays: `idleMs` after
 * nothing holds it (a drawing of it shown, a request waiting for it). A hold
 * returns what lets go of it; calling that again does nothing.
 */
export function frameLifetime(idleMs: number, close: () => void): () => () => void {
  let users = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  return () => {
    users += 1
    clearTimeout(timer)
    timer = undefined
    let ended = false
    return () => {
      if (ended) return
      ended = true
      users -= 1
      if (users === 0) timer = setTimeout(close, idleMs)
    }
  }
}
