// What a main window and a note window share in saving their notes (saving.ts): the notice's
// problems and the quit and close guards, saving as the page goes, and at the end of the trial.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SaveProblem } from '../../core'
import type { Core } from './core-client'
import { invoke } from './ipc'
import { createQuitGuard, newProblems, type QuitGuard } from './saving'
import { unlistenLater } from './windowEvents'

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

const READY = {
  quit: 'app_exit_ready',
  close: 'note_window_close_ready',
} as const
const CANCEL = {
  quit: 'app_exit_cancel',
  close: 'note_window_close_cancel',
} as const

/**
 * Answers Rust's quit or close of this window, which it holds until then. A window with nothing to
 * save (`save` undefined) goes. Otherwise `guard` decides on the save: the first one that fails is
 * called off (`held` runs, so the window can say so), and the next goes on without the changes;
 * `beforeExit` runs just before Rust is told to go on.
 */
export async function answerAsked(
  asked: 'quit' | 'close',
  guard: QuitGuard,
  save: Promise<unknown> | undefined,
  held: () => void,
  beforeExit?: () => Promise<unknown>,
): Promise<void> {
  const answer = save ? await guard.answer(save) : 'exit'
  if (answer === 'exit') {
    await beforeExit?.()
    await invoke(READY[asked])
    return
  }
  held()
  await invoke(CANCEL[asked])
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

/** Rust asks one window to close (a note window, or a main window File > New Window opened); UI tests ask with this page event. */
export const CLOSE_EVENT = 'devot:note-window-close'
/** Rust asks every window to save before the app quits; UI tests ask note windows with this page event. */
export const FLUSH_EVENT = 'devot:flush-before-exit'

/** Hears Rust ask this window, and no other, to close. */
export function listenCloseAsked(onClose: () => void): () => void {
  window.addEventListener(CLOSE_EVENT, onClose)
  const unlisten = DEVOT_UI_TEST
    ? undefined
    : unlistenLater(
        import('@tauri-apps/api/webviewWindow').then(({ getCurrentWebviewWindow }) =>
          getCurrentWebviewWindow().listen('devot://note-window-close', onClose),
        ),
      )
  return () => {
    window.removeEventListener(CLOSE_EVENT, onClose)
    unlisten?.()
  }
}
