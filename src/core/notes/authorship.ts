import { clearAuthorship, reverseWrites, type Reversal } from '../authorship'
import { errorCode } from '../errors'
import { lineFeeds } from '../text'
import type { NoteContext } from './context'
import type { Kernel } from './kernel'
import type { NoteService } from './types'

export function authorshipMethods(
  ctx: NoteContext,
  k: Kernel,
): Pick<
  NoteService,
  | 'agentWrite'
  | 'undoAgentWrites'
  | 'clearAuthorship'
  | 'agentWrites'
  | 'authoredNotes'
  | 'markWritesSeen'
> {
  const { storage, options, live } = ctx
  const { editBody, takeVersion, settled } = k.versions
  const { using } = k.memory
  const { save, schedule } = k.saving
  const { collected, authoredEdit } = k.edits
  return {
    agentWrite: (id, edit) =>
      using(id, (note) =>
        authoredEdit(note, {
          ...edit,
          ...(edit.markdown === undefined ? {} : { markdown: lineFeeds(edit.markdown) }),
        }),
      ),

    undoAgentWrites: (id, writer) =>
      using(id, async (note) => {
        takeVersion(note)
        let result: Reversal = { writes: 0, dropped: 0 }
        const update = collected(note, () =>
          editBody(note, () => {
            result = reverseWrites(note.doc, writer, id)
          }),
        )
        if (result.writes > 0) {
          schedule(note)
          options.log?.('I_AUTHORSHIP_UNDONE', id, String(result.writes))
        }
        await settled()
        return { ...result, update }
      }),

    clearAuthorship: (id) =>
      using(id, (note) => {
        let cleared = false
        const update = collected(note, () => {
          cleared = editBody(note, () => clearAuthorship(note.doc))
        })
        if (cleared) {
          schedule(note)
          options.log?.('I_AUTHORSHIP_CLEARED', id)
        }
        return update
      }),

    agentWrites: (limit) => storage.listAgentWrites(limit),
    authoredNotes: () => storage.authoredNotes(),

    async markWritesSeen(id, writeIds) {
      if (writeIds.length === 0) return
      const note = live.get(id)
      if (note) {
        await save(note).catch((e: unknown) =>
          console.warn('W_AGENT_WRITES_SEEN_SAVE_FAILED', id, errorCode(e)),
        )
      }
      await storage.markAgentWritesSeen(id, writeIds)
    },
  }
}
