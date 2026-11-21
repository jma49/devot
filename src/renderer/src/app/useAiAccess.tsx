import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { BookNode } from '../../../core/books'
import { CHOOSE_AI_ACCESS, inverseChanges, type AiAccessChange } from '../aiAccess'
import { AiAccessDialog } from '../AiAccessDialog'
import { AiAccessNotice } from '../AiAccessNotice'
import { errorCode } from '../backups'
import { invoke } from '../ipc'
import type { Core } from '../core-client'
import { LICENCE_REQUIRED } from '../licence'
import { saveEdits } from '../saveGuards'
import { useStable } from '../stable'
import { keepListening, listenHere } from '../windowEvents'

const AI_ACCESS_PICKER_EVENT = 'devot://ai-access-picker'

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
  // Resolves with whether every change was written.
  const writeAiAccess = useStable(async (changes: readonly AiAccessChange[]): Promise<boolean> => {
    setAiAccessPicker(false)
    if (!core || changes.length === 0) return false
    // The trial can end while the picker is open.
    if (!editing) {
      setChangeNotice(LICENCE_REQUIRED)
      return false
    }
    const failed: AiAccessChange[] = []
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
    setAiAccessResult({ changes: applied, failed: failed.length })
    return failed.length === 0
  })
  const applyAiAccess = useStable((changes: readonly AiAccessChange[]) => {
    void writeAiAccess(changes).catch((e: unknown) =>
      console.warn('W_AI_ACCESS_FAILED', errorCode(e)),
    )
  })
  // One notebook from an AI sheet that was refused for it.
  const allowAiAccess = useStable((bookId: string) =>
    writeAiAccess([{ id: bookId, on: true }]).catch((e: unknown) => {
      console.warn('W_AI_ACCESS_FAILED', errorCode(e))
      return false
    }),
  )
  const undoAiAccess = useStable(() => {
    const result = aiAccessResult
    if (!result) return
    setAiAccessResult(undefined)
    applyAiAccess(inverseChanges(result.changes))
  })

  // Settings asks Rust for the picker, which tells the frontmost main window, or holds the ask
  // for a main window that is still opening: each takes it once it listens.
  const asked = useStable(() => {
    if (editing) setAiAccessPicker(true)
    else setChangeNotice(LICENCE_REQUIRED)
  })
  useEffect(() => {
    // Before the core is ready there is no notebook tree to pick from.
    if (!core) return
    const take = () => {
      void invoke<boolean>('ai_access_picker_take')
        .then((ask) => {
          if (ask && !listening.stopped()) asked()
        })
        .catch((e: unknown) => console.warn('W_AI_ACCESS_PICKER_TAKE_FAILED', errorCode(e)))
    }
    window.addEventListener(CHOOSE_AI_ACCESS, take)
    const listening = keepListening(
      DEVOT_UI_TEST ? Promise.resolve([]) : listenHere(AI_ACCESS_PICKER_EVENT, take),
    )
    // Listening first, then asking what waits: no ask is lost between.
    listening.ready
      .catch(() => console.warn('W_AI_ACCESS_PICKER_LISTEN_FAILED'))
      .then(() => {
        if (!listening.stopped()) take()
      })
    return () => {
      listening.stop()
      window.removeEventListener(CHOOSE_AI_ACCESS, take)
    }
  }, [core, asked])
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
  return { pick: () => setAiAccessPicker(true), allow: allowAiAccess, notice, dialog }
}
