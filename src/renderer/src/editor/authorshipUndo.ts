// Undo All is an undo step of its own (editor/undo.ts), and undoing it puts the text back as an
// edit of the editor's client, with new Yjs items the records do not name. So the step carries the
// newest undone write's session and time, and its undo records what it put back as a write of that
// session (ADR 0007); redoing drops that record again.
import { invertedEffects } from '@codemirror/commands'
import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { ViewPlugin, type EditorView } from '@codemirror/view'
import { ySyncAnnotation, ySyncFacet } from 'y-codemirror.next'
import type * as Y from 'yjs'
import {
  newAuthorshipId,
  recordTransaction,
  WRITES,
  type AgentWrite,
} from '../../../core/authorship'

interface PutBack {
  id: string
  session: string
  at: number
}

const writesUndone = StateEffect.define<PutBack>()
const writesBack = StateEffect.define<PutBack>()

/**
 * The effect for the undo step of a change from the core, from the writes `doc` had before it
 * (readWrites): none unless the change dropped some.
 */
export function undoneWrites(before: readonly AgentWrite[], doc: Y.Doc): StateEffect<PutBack>[] {
  const writes = doc.getMap(WRITES)
  const newest = before.findLast((write) => !writes.has(write.id))
  return newest
    ? [writesUndone.of({ id: newAuthorshipId(), session: newest.session, at: newest.at })]
    : []
}

type Pending = { put: PutBack } | { drop: string } | null

const pending = StateField.define<Pending>({
  create: () => null,
  update(_, tr) {
    for (const effect of tr.effects) {
      if (effect.is(writesBack)) return { put: effect.value }
      // The Undo All step itself comes from the Yjs document, which already dropped the writes.
      if (effect.is(writesUndone) && tr.annotation(ySyncAnnotation) === undefined) {
        return { drop: effect.value.id }
      }
    }
    return null
  },
})

export function authorshipUndo(ydoc: Y.Doc): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      done: Pending = null

      constructor(readonly view: EditorView) {
        ydoc.on('afterTransaction', this.after)
      }

      readonly after = (tr: Y.Transaction) => {
        if (tr.origin !== this.view.state.facet(ySyncFacet)) return
        const step = this.view.state.field(pending)
        if (!step || step === this.done) return
        this.done = step
        if ('put' in step) recordTransaction(ydoc, tr, step.put)
        else ydoc.transact(() => ydoc.getMap(WRITES).delete(step.drop))
      }

      destroy() {
        ydoc.off('afterTransaction', this.after)
      }
    },
  )
  return [
    pending,
    plugin,
    invertedEffects.of((tr) =>
      tr.effects.flatMap((effect) =>
        effect.is(writesUndone)
          ? [writesBack.of(effect.value)]
          : effect.is(writesBack)
            ? [writesUndone.of(effect.value)]
            : [],
      ),
    ),
  ]
}
