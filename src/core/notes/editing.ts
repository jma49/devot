import * as Y from 'yjs'
import { appendInsertion } from '../append'
import { newWriter } from '../authorship'
import { MAX_BODY_BYTES, overBytes } from '../noteLimits'
import { AI_EDIT } from '../revisions'
import { lineFeeds } from '../text'
import { BODY } from './body'
import type { NoteContext } from './context'
import type { Kernel } from './kernel'
import type { NoteService } from './types'

/** The end of the body when there is no position or it names another text. */
function anchoredIndex(doc: Y.Doc, text: Y.Text, anchor: Uint8Array | null): number {
  if (anchor) {
    try {
      const found = Y.createAbsolutePositionFromRelativePosition(
        Y.decodeRelativePosition(anchor),
        doc,
      )
      if (found?.type === text) return Math.min(found.index, text.length)
    } catch {}
  }
  return text.length
}

export function editingMethods(
  ctx: NoteContext,
  k: Kernel,
): Pick<
  NoteService,
  | 'applyUpdate'
  | 'setBody'
  | 'setBodyFrom'
  | 'fill'
  | 'insertAt'
  | 'applyAiEdit'
  | 'applyPluginEdit'
  | 'appendToNote'
> {
  const { clock } = ctx
  const { editBody, takeVersion, settled } = k.versions
  const { using } = k.memory
  const { schedule } = k.saving
  const { retitle, replaceBody, collected, authoredEdit } = k.edits
  return {
    applyUpdate: (id, update) =>
      using(id, (note) => {
        editBody(note, () => Y.applyUpdate(note.doc, update))
        schedule(note)
      }),

    setBody: (id, markdown) => using(id, (note) => replaceBody(note, lineFeeds(markdown))),
    setBodyFrom: (id, expected, markdown) =>
      using(id, (note) => {
        if (note.doc.getText(BODY).toString() !== lineFeeds(expected)) return false
        replaceBody(note, lineFeeds(markdown))
        return true
      }),

    fill: (id, { title, markdown }) =>
      using(id, (note) => {
        if (note.record.title === '' && title !== '') retitle(note, title)
        const text = note.doc.getText(BODY)
        const own = text.toString()
        if (own.trim() === '') return replaceBody(note, lineFeeds(markdown))
        const breaks = /\n*$/.exec(own)?.[0].length ?? 0
        editBody(note, () =>
          text.insert(text.length, `${'\n'.repeat(Math.max(0, 2 - breaks))}${lineFeeds(markdown)}`),
        )
        schedule(note)
      }),

    insertAt: (id, anchor, markdown) =>
      using(id, (note) => {
        const text = note.doc.getText(BODY)
        const index = anchoredIndex(note.doc, text, anchor)
        if (!markdown) return
        editBody(note, () => text.insert(index, lineFeeds(markdown)))
        schedule(note)
      }),

    applyAiEdit: (id, { from, original, replacement }) =>
      using(id, async (note) => {
        const body = note.doc.getText(BODY).toString()
        const moved = body.indexOf(original)
        const at = body.startsWith(original, from) ? from : moved
        if (at !== from && (moved < 0 || body.includes(original, moved + 1))) {
          throw new Error('E_AI_PROPOSAL_STALE')
        }
        takeVersion(note)
        const next = lineFeeds(replacement)
        const markdown = body.slice(0, at) + next + body.slice(at + original.length)
        // Each Edit with AI sheet is a session of its own, and it accepts once.
        const writer = newWriter('aiEdit', '', clock.node)
        const update = collected(note, () => authoredEdit(note, { writer, markdown }))
        takeVersion(note, AI_EDIT)
        await settled()
        return update
      }),

    applyPluginEdit: (id, { base, markdown }) =>
      using(id, async (note) => {
        if (note.doc.getText(BODY).toString() !== base) throw new Error('E_PLUGIN_NOTE_CHANGED')
        takeVersion(note)
        const update = collected(note, () => replaceBody(note, lineFeeds(markdown)))
        takeVersion(note)
        await settled()
        return update
      }),

    appendToNote: (id, text, where) =>
      using(id, async (note) => {
        const body = note.doc.getText(BODY)
        const insertion = appendInsertion(body.toString(), text, where)
        if (overBytes(body.toString() + insertion.text, MAX_BODY_BYTES)) {
          throw new Error('E_NOTE_BODY_TOO_LARGE')
        }
        takeVersion(note)
        const update = collected(note, () => {
          editBody(note, () => note.doc.transact(() => body.insert(insertion.at, insertion.text)))
          schedule(note)
        })
        takeVersion(note)
        await settled()
        return update
      }),
  }
}
