// What a main window and a note window share in saving their notes (saving.ts): the notice's
// problems and the quit and close guards, saving as the page goes, and at the end of the trial.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SaveProblem } from '../../core'
import type { Core } from './core-client'
import { createQuitGuard, newProblems } from './saving'

/** Flushes pending edits; a failed save stays in the core (which retries and reports it), so the caller goes on. */
export const saveEdits = (core: Core) => core.flush().catch(() => {})

/**
 * The core's unsaved notes (`onSaveProblems` goes to `startCore`): each new failure is logged by
 * code and brings the notice back, and the quit and close guards follow the list. `changed` hears
 * each list with the one before it.
 */
export function useSaveProblems(
  changed: (previous: readonly SaveProblem[], next: SaveProblem[]) => void,
) {
  const [problems, setProblems] = useState<SaveProblem[]>([])
  const [dismissed, setDismissed] = useState(false)
  const problemsRef = useRef<SaveProblem[]>([])
  const [quitGuard] = useState(createQuitGuard)
  const [closeGuard] = useState(createQuitGuard)
  const onSaveProblems = useCallback(
    (next: SaveProblem[]) => {
      const previous = problemsRef.current
      problemsRef.current = next
      const fresh = newProblems(previous, next)
      for (const problem of fresh) console.warn('W_NOTE_SAVE_FAILED', problem.id, problem.code)
      if (fresh.length > 0) setDismissed(false)
      quitGuard.update(next)
      closeGuard.update(next)
      setProblems(next)
      changed(previous, next)
    },
    [quitGuard, closeGuard, changed],
  )
  return {
    problems,
    noticeShown: problems.length > 0 && !dismissed,
    setDismissed,
    quitGuard,
    closeGuard,
    onSaveProblems,
  }
}

/** Saves the pending edits when the page goes away or out of sight. */
export function useSaveOnHide(core: Core | undefined) {
  useEffect(() => {
    if (!core) return
    const flush = () => void saveEdits(core)
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', flush)
    }
  }, [core])
}

/**
 * The trial ended with notes open: what was typed is saved (Rust still takes a note's text for a
 * few minutes) as the window turns read-only. `first` runs just before.
 */
export function useSaveAtTrialEnd(editing: boolean, core: Core | undefined, first?: () => void) {
  const before = useRef(first)
  useEffect(() => {
    before.current = first
  })
  const wasEditing = useRef(editing)
  useEffect(() => {
    if (wasEditing.current && !editing && core) {
      before.current?.()
      void core.flush({ versions: true }).catch(() => console.warn('W_TRIAL_END_SAVE_FAILED'))
    }
    wasEditing.current = editing
  }, [editing, core])
}
