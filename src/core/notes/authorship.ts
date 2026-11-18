import {
  clearAuthorship,
  newAuthorshipId,
  restoreWrites,
  reverseWrites,
  undoWrite,
  type Reversal,
  type UndoneWrites,
} from '../authorship'
import { errorCode } from '../errors'
import { lineFeeds } from '../text'
import type { Live, NoteContext } from './context'
import type { Kernel } from './kernel'
import type { NoteService } from './types'

export function authorshipMethods(
  ctx: NoteContext,
  k: Kernel,
): Pick<
  NoteService,
  | 'agentWrite'
  | 'undoAgentWrites'
  | 'undoAgentWrite'
  | 'restoreAgentWrites'
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
  // The newest Undo of several writes, while Restore may still take it back: one at a time, as the window offers one.
  let restorable: { noteId: string; token: string; undone: UndoneWrites } | undefined
  const reverseIn = (id: string, note: Live, reverse: () => Reversal) => {
    takeVersion(note)
    let result: Reversal = { writes: 0, dropped: 0 }
    const update = collected(note, () =>
      editBody(note, () => {
        result = reverse()
      }),
    )
    if (result.writes > 0) {
      schedule(note)
      options.log?.('I_AUTHORSHIP_UNDONE', id, String(result.writes))
    }
    return settled().then(() => ({ ...result, update }))
  }
  return {
    agentWrite: (id, edit) =>
      using(id, (note) =>
        authoredEdit(note, {
          ...edit,
          ...(edit.markdown === undefined ? {} : { markdown: lineFeeds(edit.markdown) }),
        }),
      ),

    undoAgentWrites: (id, writer) =>
      using(id, (note) => reverseIn(id, note, () => reverseWrites(note.doc, writer, id))),

    undoAgentWrite: (id, writeId) =>
      using(id, (note) => {
        restorable = undefined
        let undone: UndoneWrites | undefined
        const result = reverseIn(id, note, () => {
          const done = undoWrite(note.doc, writeId, id)
          undone = done.undone
          return done.reversal
        })
        if (!undone || undone.writes.length < 2) return result
        const offer = { noteId: id, token: newAuthorshipId(), undone }
        restorable = offer
        return result.then((reversal) => ({
          ...reversal,
          restore: { token: offer.token, writes: [...offer.undone.writes] },
        }))
      }),

    restoreAgentWrites: (id, token) =>
      using(id, (note) => {
        const offer = restorable
        if (offer?.noteId !== id || offer.token !== token)
          throw new Error('E_AUTHORSHIP_RESTORE_STALE')
        restorable = undefined
        takeVersion(note)
        let restored = false
        const update = collected(note, () =>
          editBody(note, () => {
            restored = restoreWrites(note.doc, offer.undone)
          }),
        )
        if (!restored) throw new Error('E_AUTHORSHIP_RESTORE_STALE')
        schedule(note)
        options.log?.('I_AUTHORSHIP_RESTORED', id, String(offer.undone.writes.length))
        return settled().then(() => ({
          writes: offer.undone.writes.length,
          update,
        }))
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
