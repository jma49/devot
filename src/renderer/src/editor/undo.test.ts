import { history, redo, undo, undoDepth } from '@codemirror/commands'
import {
  EditorSelection,
  EditorState,
  Transaction,
  type EditorStateConfig,
  type TransactionSpec,
} from '@codemirror/state'
import { afterEach, describe, expect, it } from 'vitest'
import { YSyncConfig, ySyncAnnotation } from 'y-codemirror.next'
import * as Y from 'yjs'
import { BODY } from '../../../core/notes'
import { keepUndo, noteState, UNDO_NOTES, yjsHistory } from './undo'

let restoring = false
const extensions = [history(), yjsHistory(() => restoring)]
const fromYjs = ySyncAnnotation.of(new YSyncConfig(new Y.Doc().getText('body'), null))

afterEach(() => {
  restoring = false
})

const start = (doc: string) => EditorState.create({ doc, extensions })
const apply = (state: EditorState, spec: TransactionSpec) => state.update(spec).state

const type = (state: EditorState, at: number, text: string, time: number) =>
  apply(state, {
    changes: { from: at, insert: text },
    selection: { anchor: at + text.length },
    userEvent: 'input.type',
    annotations: Transaction.time.of(time),
  })

const synced = (state: EditorState, from: number, to: number, insert: string, time: number) =>
  apply(state, {
    changes: { from, to, insert },
    annotations: [fromYjs, Transaction.time.of(time)],
  })

function replica(text: string): Y.Doc {
  const doc = new Y.Doc()
  doc.getText(BODY).insert(0, text)
  return doc
}

function edit(
  state: EditorState,
  doc: Y.Doc,
  from: number,
  to: number,
  insert: string,
  time: number,
) {
  const body = doc.getText(BODY)
  body.delete(from, to - from)
  body.insert(from, insert)
  return apply(state, {
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    userEvent: insert ? 'input.type' : 'delete.backward',
    annotations: Transaction.time.of(time),
  })
}

function changedElsewhere(doc: Y.Doc, ...changes: [at: number, remove: number, insert: string][]) {
  const core = new Y.Doc()
  Y.applyUpdate(core, Y.encodeStateAsUpdate(doc))
  const body = core.getText(BODY)
  // Each in a transaction of its own, the last first, so the offsets are the note's as it was.
  for (const [at, remove, insert] of [...changes].reverse()) {
    core.transact(() => {
      body.delete(at, remove)
      body.insert(at, insert)
    })
  }
  return core
}

function leave(noteId: string, state: EditorState): Y.Doc {
  const doc = replica(state.doc.toString())
  keepUndo(noteId, state, doc)
  return doc
}

const show = (noteId: string, doc: Y.Doc, config: Omit<EditorStateConfig, 'doc'> = {}) =>
  noteState(noteId, { ...config, doc: doc.getText(BODY).toString(), extensions }, doc)

function run(state: EditorState, command: typeof undo): EditorState {
  let next = state
  command({ state, dispatch: (tr) => (next = tr.state) })
  return next
}

describe('changes from the Yjs document', () => {
  it('are not undone, and do not join the typing around them', () => {
    let state = type(start('abc'), 3, 'X', 1000)
    state = synced(state, 0, 0, 'From outside. ', 1100)
    state = type(state, state.doc.length, 'Y', 1200)
    state = run(state, undo)
    expect(state.doc.toString()).toBe('From outside. abc')
    expect(undoDepth(state)).toBe(0)
    state = run(state, redo)
    expect(state.doc.toString()).toBe('From outside. abcXY')
  })

  it('take a restored version as one undo step of its own', () => {
    let state = type(start('abc'), 3, 'X', 1000)
    restoring = true
    state = synced(state, 0, 4, 'old', 1100)
    restoring = false
    // Typing right after it, next to it, is a step of its own.
    state = type(state, 3, 'Z', 1200)
    state = run(state, undo)
    expect(state.doc.toString()).toBe('old')
    state = run(state, undo)
    expect(state.doc.toString()).toBe('abcX')
    state = run(state, undo)
    expect(state.doc.toString()).toBe('abc')
  })
})

describe('a note shown again', () => {
  it('goes on undoing where it stopped', () => {
    const doc = leave('note-a', type(start('abc'), 3, 'X', 1000))
    let state = show('note-a', doc, { selection: EditorSelection.single(4) })
    expect(state.selection.main.head).toBe(4)
    expect(undoDepth(state)).toBe(1)
    state = run(state, undo)
    expect(state.doc.toString()).toBe('abc')
  })

  it('keeps what changed while it was away, and undoes only the typing', () => {
    const doc = leave('note-b', type(start('abc'), 3, 'X', 1000))
    let state = show('note-b', changedElsewhere(doc, [0, 0, 'Outside ']))
    expect(state.doc.toString()).toBe('Outside abcX')
    state = run(state, undo)
    expect(state.doc.toString()).toBe('Outside abc')
    expect(undoDepth(state)).toBe(0)
  })

  it('undoes a deletion in place when it was changed before and after it meanwhile', () => {
    const text = 'Intro\nMiddle with KEEP word\nEnd'
    const doc = replica(text)
    const at = text.indexOf('KEEP ')
    keepUndo('note-ends', edit(start(text), doc, at, at + 5, '', 1000), doc)
    const core = changedElsewhere(doc, [5, 0, '2'], [doc.getText(BODY).length, 0, '2'])
    let state = show('note-ends', core)
    expect(state.doc.toString()).toBe('Intro2\nMiddle with word\nEnd2')
    state = run(state, undo)
    expect(state.doc.toString()).toBe('Intro2\nMiddle with KEEP word\nEnd2')
  })

  it('undoes typing in place when it was changed before and after it meanwhile', () => {
    const text = 'Intro\nMiddle\nEnd'
    const doc = replica(text)
    keepUndo('note-typed', edit(start(text), doc, 12, 12, ' typed', 1000), doc)
    const core = changedElsewhere(doc, [0, 0, '# '], [doc.getText(BODY).length, 0, '.'])
    let state = show('note-typed', core)
    expect(state.doc.toString()).toBe('# Intro\nMiddle typed\nEnd.')
    state = run(state, undo)
    expect(state.doc.toString()).toBe('# Intro\nMiddle\nEnd.')
  })

  it('has no history when its document is not the one it was left with', () => {
    // A document with the same text that does not hold the replica's changes
    // (made anew from the text, not from the replica).
    leave('note-other', type(start('abc'), 3, 'X', 1000))
    const state = show('note-other', replica('abcX!'))
    expect(state.doc.toString()).toBe('abcX!')
    expect(undoDepth(state)).toBe(0)
  })

  it('starts a new step with the next typing', () => {
    const doc = leave('note-c', type(start('abc'), 3, 'X', 1000))
    let state = show('note-c', doc)
    state = type(state, 4, 'Y', 1100)
    state = run(state, undo)
    expect(state.doc.toString()).toBe('abcX')
  })

  it('has no history when it was never left', () => {
    const state = show('note-new', replica('abc'))
    expect(state.doc.toString()).toBe('abc')
    expect(undoDepth(state)).toBe(0)
  })

  it(`keeps the history of the last ${UNDO_NOTES} notes left only`, () => {
    const ids = Array.from({ length: UNDO_NOTES + 1 }, (_, i) => `note-lru-${i}`)
    const docs = ids.map((id) => leave(id, type(start('abc'), 3, 'X', 1000)))
    expect(undoDepth(show(ids[0]!, docs[0]!))).toBe(0)
    expect(undoDepth(show(ids[1]!, docs[1]!))).toBe(1)
    expect(undoDepth(show(ids[UNDO_NOTES]!, docs[UNDO_NOTES]!))).toBe(1)
  })
})
