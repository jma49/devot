import type { RefObject } from 'react'
import type { Core } from '../core-client'
import type { EditorHandle } from '../editor/handle'
import { useExternalChanges } from '../externalChanges'
import { saveEdits } from '../saveGuards'

export function useExternalMerge({
  core,
  selected,
  inTrash,
  opens,
  editorRef,
  setTitle,
  refresh,
  agentWrites,
}: {
  core: Core | undefined
  selected: string | undefined
  inTrash: boolean
  opens: RefObject<number>
  editorRef: RefObject<EditorHandle | null>
  setTitle: (title: string) => void
  refresh: (c: Core) => Promise<unknown>
  agentWrites: { reload: () => void }
}) {
  // Another process changed the database: notes in memory take in its writes before saving anything (so no save overwrites them), then pending edits save and the lists reload.
  useExternalChanges(
    core
      ? async () => {
          const shown = selected && !inTrash ? selected : undefined
          const navigation = opens.current
          const titled = await core.mergeStored()
          const editor = editorRef.current?.noteId === shown ? editorRef.current : null
          const opened = shown
            ? await core.open(shown, editor?.vector()).catch(() => undefined)
            : undefined
          if (opened && opens.current === navigation) {
            const outsideTitle = titled.find((note) => note.id === opened.id)?.title
            if (outsideTitle !== undefined) setTitle(outsideTitle)
            const now = editorRef.current
            if (now?.noteId === opened.id) {
              // An editor that opened meanwhile takes the whole state.
              const state =
                now === editor
                  ? opened.state
                  : (await core.open(opened.id).catch(() => undefined))?.state
              if (state && editorRef.current === now) now.takeState(state)
            }
          }
          await saveEdits(core)
          void core.mirrorTouch()
          await refresh(core)
          // Seen writes change no note: the other windows' marks need this read too.
          agentWrites.reload()
        }
      : undefined,
  )
}
