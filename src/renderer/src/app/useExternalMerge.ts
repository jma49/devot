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
  patch,
  agentWrites,
}: {
  core: Core | undefined
  selected: string | undefined
  inTrash: boolean
  opens: RefObject<number>
  editorRef: RefObject<EditorHandle | null>
  setTitle: (title: string) => void
  refresh: (c: Core) => Promise<unknown>
  /** Reads again the list rows of notes a write changed, when it changed nothing else. */
  patch: (c: Core, ids: readonly string[]) => Promise<unknown>
  agentWrites: { reload: () => void }
}) {
  // Another process changed the database: notes in memory take in its writes before saving anything (so no save overwrites them), then pending edits save and the lists reload.
  useExternalChanges(
    core
      ? async (notes) => {
          const shown = selected && !inTrash ? selected : undefined
          const navigation = opens.current
          const { retitled, unchanged } = await core.mergeStored()
          const outsideTitle = retitled.find((note) => note.id === shown)?.title
          if (outsideTitle !== undefined && opens.current === navigation) setTitle(outsideTitle)
          // A note whose stored version did not move took nothing in: its editor keeps its state, caret and undo.
          const moved = shown !== undefined && !unchanged.includes(shown)
          const editor = editorRef.current?.noteId === shown ? editorRef.current : null
          const opened = moved
            ? await core.open(shown, editor?.vector()).catch(() => undefined)
            : undefined
          if (opened && opens.current === navigation) {
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
          await (notes ? patch(core, notes) : refresh(core))
          // Seen writes change no note: the other windows' marks need this read too.
          agentWrites.reload()
        }
      : undefined,
  )
}
