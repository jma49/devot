import { useState } from 'react'
import { useStable } from '../stable'

/**
 * Settings choices that Rust takes as one whole (every field with each save), saved one after
 * another so two saves never race. `held` is what Rust last said it holds; the choices sent next
 * are `held` with every change not yet sent laid over it.
 */
export interface QueuedChoices<C extends object> {
  /** Starts a read of Rust's choices: its answer is taken in only if no save was queued, ran or ended since. */
  reading(): (loaded: C) => boolean
  /** Changes some fields and saves the whole once the saves before have answered. */
  change(patch: Partial<C>): void
}

export function createQueuedChoices<C extends object>(
  save: (sent: C) => Promise<C>,
  refused: (e: unknown) => void,
): QueuedChoices<C> {
  let held: C | null = null
  let unsent: Partial<C> = {}
  let pending = 0
  // Counts queued and answered saves, so a read that began before one is known to be stale.
  let saves = 0
  let queue = Promise.resolve()

  const wanted = (): C | null => (held ? { ...held, ...unsent } : null)

  return {
    reading() {
      const started = saves
      return (loaded) => {
        if (pending > 0 || saves !== started) return false
        held = loaded
        return true
      }
    },
    change(patch) {
      if (!held) return
      unsent = { ...unsent, ...patch }
      pending += 1
      saves += 1
      queue = queue.then(async () => {
        const sent = wanted()
        const changed = Object.keys(unsent).length > 0
        unsent = {}
        try {
          // An earlier save in the queue already sent this change.
          if (sent && changed) held = await save(sent)
        } catch (e) {
          // Rust kept what it held, which `held` still is.
          refused(e)
        } finally {
          pending -= 1
          saves += 1
        }
      })
    },
  }
}

export function useQueuedChoices<C extends object>(
  save: (sent: C) => Promise<C>,
  refused: (e: unknown) => void,
): QueuedChoices<C> {
  const latestSave = useStable(save)
  const latestRefused = useStable(refused)
  const [choices] = useState(() => createQueuedChoices(latestSave, latestRefused))
  return choices
}
