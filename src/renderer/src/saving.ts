// Notes the core could not save yet (NoteService, onSaveProblems): it keeps
// their changes in memory and tries again. The window logs each failure,
// shows a notice while any is left (SaveNotice.tsx), and holds a quit once,
// so the changes are never dropped without the user knowing.
import type { SaveProblem } from '../../core'

/** The problems in `next` that are new: a note not failing before, or failing with another code. */
export function newProblems(
  previous: readonly SaveProblem[],
  next: readonly SaveProblem[],
): SaveProblem[] {
  return next.filter((p) => !previous.some((q) => q.id === p.id && q.code === p.code))
}

/**
 * What the core worker sends the page with each new list of problems. It
 * goes on the worker's own channel, as the replies to the page's calls do,
 * so the page hears of a failure before the reply of the call it happened
 * in. (A callback handed to the worker would send on a channel of its own,
 * whose messages can arrive after that reply.)
 */
export interface SaveProblemsMessage {
  saveProblems: SaveProblem[]
}

/** The problems a message from the core worker carries; undefined for any other message. */
export function saveProblemsIn(data: unknown): SaveProblem[] | undefined {
  if (typeof data !== 'object' || data === null || !('saveProblems' in data)) return undefined
  return Array.isArray(data.saveProblems) ? (data.saveProblems as SaveProblem[]) : undefined
}

export interface QuitGuard {
  /**
   * Waits for the quit's save (`save` rejects when a note could not be
   * saved), then answers whether to exit now, or to hold this quit and keep
   * the window open with the changes. Any failure counts, whether or not
   * its notes have been reported yet. Only the first quit after notes start
   * failing is held; the next one goes on without them.
   */
  answer(save: Promise<unknown>): Promise<'exit' | 'hold'>
  /** The core's latest problems: once none is left, a later failure holds a quit again. */
  update(problems: readonly SaveProblem[]): void
}

export function createQuitGuard(): QuitGuard {
  let held = false
  return {
    async answer(save) {
      const saved = await save.then(
        () => true,
        () => false,
      )
      if (saved || held) return 'exit'
      held = true
      return 'hold'
    },
    update(problems) {
      if (problems.length === 0) held = false
    },
  }
}
