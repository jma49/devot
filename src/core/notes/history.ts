import { charsChanged, foldUnchanged, lineDiff, passageInserts } from '../diff'
import { historyEntries } from '../revisions'
import { BODY, bodyText } from './body'
import type { NoteContext } from './context'
import type { Kernel } from './kernel'
import type { NoteService } from './types'

const MAX_CHANGES_KEPT = 10_000

const notFound = () => new Error('E_REVISION_NOT_FOUND')

export function historyMethods(
  ctx: NoteContext,
  k: Kernel,
): Pick<
  NoteService,
  | 'history'
  | 'compareRevision'
  | 'restoreRevision'
  | 'versionChanges'
  | 'revisionText'
  | 'restorePassage'
> {
  const { storage } = ctx
  const { editBody, takeVersion, settled } = k.versions
  const { using } = k.memory
  const { saveAll } = k.saving
  const { replaceBody, collected } = k.edits
  // Versions never change, so what one changed from the one before is worked out once (versionChanges).
  const changesKept = new Map<string, number>()

  const bodyVersion = async (id: string, revisionId: string) => {
    const revision = await storage.getRevision(revisionId)
    if (!revision || revision.noteId !== id || revision.kind !== 'body' || !revision.ydoc) {
      throw notFound()
    }
    return bodyText(revision.ydoc)
  }

  return {
    async history(id) {
      await saveAll()
      await settled()
      return historyEntries(await storage.listRevisions(id))
    },

    compareRevision: (id, revisionId) =>
      using(id, async (note) => {
        const old = await bodyVersion(id, revisionId)
        return foldUnchanged(lineDiff(old, note.doc.getText(BODY).toString()))
      }),

    restoreRevision: (id, revisionId) =>
      using(id, async (note) => {
        const old = await bodyVersion(id, revisionId)
        takeVersion(note)
        const update = collected(note, () => replaceBody(note, old))
        await settled()
        return update
      }),

    async versionChanges(id) {
      await saveAll()
      await settled()
      const versions = (await storage.listRevisions(id))
        .filter((r) => r.kind === 'body')
        .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
      const out: Record<string, number> = {}
      let before: { id: string; text?: string } | undefined
      for (const version of versions) {
        if (before) {
          const key = `${before.id}>${version.id}`
          let chars = changesKept.get(key)
          if (chars === undefined) {
            before.text ??= await bodyVersion(id, before.id)
            const text = await bodyVersion(id, version.id)
            chars = charsChanged(before.text, text)
            if (changesKept.size >= MAX_CHANGES_KEPT) changesKept.clear()
            changesKept.set(key, chars)
            before = { id: version.id, text }
          } else {
            before = { id: version.id }
          }
          out[version.id] = chars
        } else {
          before = { id: version.id }
        }
      }
      return out
    },

    revisionText: (id, revisionId) => bodyVersion(id, revisionId),

    restorePassage: (id, revisionId, { from, to }) =>
      using(id, async (note) => {
        const old = await bodyVersion(id, revisionId)
        const text = note.doc.getText(BODY)
        const inserts = passageInserts(old, text.toString(), from, to)
        if (inserts.length === 0) throw new Error('E_PASSAGE_NOT_REMOVED')
        takeVersion(note)
        const update = collected(note, () =>
          editBody(note, () =>
            note.doc.transact(() => {
              for (const insert of inserts.reverse()) text.insert(insert.at, insert.text)
            }),
          ),
        )
        takeVersion(note)
        await settled()
        return update
      }),
  }
}
