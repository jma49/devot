import { useCallback, useState, type RefObject } from 'react'
import type { SaveProblem } from '../../../core'
import type { Core } from '../core-client'
import { SaveNotice } from '../SaveNotice'
import { saveEdits, useSaveProblems } from '../saveGuards'

/** Notes the core could not save yet, the notice that names them, and the quit or close it holds. */
export function useSaveNotice({
  core,
  coreRef,
  refresh,
}: {
  core: Core | undefined
  coreRef: RefObject<Core | undefined>
  refresh: (c: Core) => Promise<unknown>
}) {
  // The first quit or close after a save failure is held (saving.ts, useSaveProblems).
  const [quitHeld, setQuitHeld] = useState(false)
  const [closeHeld, setCloseHeld] = useState(false)
  // Once a note saves, the lists show what is stored.
  const {
    problems: saveProblems,
    noticeShown: saveNoticeShown,
    setDismissed: setSaveNoticeDismissed,
    quitGuard,
    closeGuard,
    onSaveProblems,
  } = useSaveProblems(
    useCallback(
      (previous: readonly SaveProblem[], next: SaveProblem[]) => {
        if (next.length === 0) {
          setQuitHeld(false)
          setCloseHeld(false)
        }
        const c = coreRef.current
        if (c && previous.some((p) => !next.some((n) => n.id === p.id))) {
          void refresh(c).catch(() => {})
        }
      },
      [coreRef, refresh],
    ),
  )
  const notice = saveNoticeShown ? (
    <SaveNotice
      problems={saveProblems}
      quitHeld={quitHeld}
      closeHeld={closeHeld}
      onRetry={() => void (core && saveEdits(core))}
      onDismiss={() => setSaveNoticeDismissed(true)}
    />
  ) : null
  return {
    onSaveProblems,
    notice,
    held: { quitGuard, closeGuard, setSaveNoticeDismissed, setQuitHeld, setCloseHeld },
  }
}
