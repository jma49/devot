import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { BookNode } from '../../../core/books'
import { CHOOSE_AI_ACCESS, inverseChanges, type AiAccessChange } from '../aiAccess'
import { AiAccessDialog } from '../AiAccessDialog'
import { AiAccessNotice } from '../AiAccessNotice'
import { errorCode } from '../backups'
import type { Core } from '../core-client'
import { saveEdits } from '../saveGuards'
import { useStable } from '../stable'

/** Allow AI Access for several notebooks at once: the picker, the writes and the notice that undoes them. */
export function useAiAccess({
  core,
  editing,
  refresh,
  reloadStarted,
  reloadDone,
  setChangeNotice,
  tree,
  counts,
}: {
  core: Core | undefined
  editing: boolean
  refresh: (c: Core) => Promise<unknown>
  reloadStarted: () => void
  reloadDone: () => void
  setChangeNotice: Dispatch<SetStateAction<string | undefined>>
  tree: BookNode[]
  counts: ReadonlyMap<string, number>
}) {
  const [aiAccessPicker, setAiAccessPicker] = useState(false)
  const [aiAccessResult, setAiAccessResult] = useState<{
    changes: readonly AiAccessChange[]
    failed: number
  }>()
  // Allow AI Access on or off for several notebooks, each its own write: a
  // notebook that fails does not stop the rest, and the notice offers Undo.
  const applyAiAccess = useStable((changes: readonly AiAccessChange[]) => {
    setAiAccessPicker(false)
    if (!core || !editing || changes.length === 0) return
    const failed: AiAccessChange[] = []
    void (async () => {
      setChangeNotice(undefined)
      reloadStarted()
      try {
        await saveEdits(core)
        for (const change of changes) {
          try {
            await core.setBookAiAccess(change.id, change.on)
          } catch (e) {
            failed.push(change)
            console.warn('W_AI_ACCESS_FAILED', change.id, errorCode(e))
          }
        }
        await saveEdits(core)
        await refresh(core)
      } finally {
        reloadDone()
      }
      const applied = changes.filter((change) => !failed.includes(change))
      if (applied.length === 0 && failed.length === 0) return
      setAiAccessResult({ changes: applied, failed: failed.length })
    })()
  })
  const undoAiAccess = useStable(() => {
    const result = aiAccessResult
    if (!result) return
    setAiAccessResult(undefined)
    applyAiAccess(inverseChanges(result.changes))
  })

  // Settings > Integrations leaves a flag in the storage both windows share,
  // then focuses the main window (opening one if needed): the picker opens here.
  useEffect(() => {
    // Before the core is ready there is no notebook tree to pick from.
    if (!core) return
    const check = () => {
      try {
        if (localStorage.getItem(CHOOSE_AI_ACCESS) === null) return
        localStorage.removeItem(CHOOSE_AI_ACCESS)
      } catch {
        return
      }
      setAiAccessPicker(true)
    }
    check()
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [core])
  const notice = aiAccessResult ? (
    <AiAccessNotice
      changes={aiAccessResult.changes}
      failed={aiAccessResult.failed}
      onUndo={undoAiAccess}
      onDismiss={() => setAiAccessResult(undefined)}
    />
  ) : null
  const dialog = aiAccessPicker ? (
    <AiAccessDialog
      tree={tree}
      counts={counts}
      onApply={applyAiAccess}
      onCancel={() => setAiAccessPicker(false)}
    />
  ) : null
  return { pick: () => setAiAccessPicker(true), notice, dialog }
}
