// Switching away from a note and back on a note of about 2 MB that was typed over several sessions,
// so its Yjs state has many items: what the switch task costs on the page, and what the worker's
// open costs. Each budget is a baseline measured on a developer's Mac with room for a busy machine.
import { join } from 'node:path'
import { history, undoDepth } from '@codemirror/commands'
import { EditorSelection, EditorState, Transaction } from '@codemirror/state'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { BODY, createClock, createIdGenerator, createNoteService } from '../../src/core'
import { authoredField } from '../../src/renderer/src/editor/authorship'
import { keepUndo, noteState } from '../../src/renderer/src/editor/undo'
import { expectWithinBudget } from '../support/budget'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const LINES = 36_000
const TIMEOUT_MS = 120_000

/** About 2 MB of text, typed a word at a time in 10 sessions with corrections earlier on. */
function typedNote(): Uint8Array {
  const doc = new Y.Doc()
  for (let session = 0; session < 10; session += 1) {
    const typist = new Y.Doc()
    typist.clientID = 100 + session
    Y.applyUpdate(typist, Y.encodeStateAsUpdate(doc))
    const text = typist.getText(BODY)
    for (let i = 0; i < LINES / 10; i += 1) {
      for (const word of `Line ${i} of a long note, with some words to make it wide.`.split(' ')) {
        text.insert(text.length, `${word} `)
        if (i % 7 === 0) text.delete(text.length - 2, 1)
      }
      text.insert(text.length, '\n')
      if (i % 3 === 0) text.insert(Math.floor(text.length / 2), ',')
    }
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(typist, Y.encodeStateVector(doc)))
  }
  return Y.encodeStateAsUpdate(doc)
}

let typedOnce: Uint8Array | undefined
const typedState = () => (typedOnce ??= typedNote())

const median = (times: number[]) => times.sort((a, b) => a - b)[Math.floor(times.length / 2)]!

function timed(work: () => void, rounds = 5): number {
  const times: number[] = []
  for (let i = 0; i < rounds; i += 1) {
    const start = performance.now()
    work()
    times.push(performance.now() - start)
  }
  return median(times)
}

const replicaOf = (state: Uint8Array) => {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  return doc
}

const extensions = [history()]

describe('switching notes on a 2 MB note', { timeout: TIMEOUT_MS }, () => {
  let state: Uint8Array
  let body: string
  beforeAll(() => {
    state = typedState()
    body = replicaOf(state).getText(BODY).toString()
  })

  it('is about 2 MB of text', () => {
    expect(body.length).toBeGreaterThan(2_000_000)
  })

  it('leaves a note with no undo history at once', (context) => {
    const doc = replicaOf(state)
    const shown = EditorState.create({ doc: body, extensions })
    const ms = timed(() => keepUndo('plain', shown, doc))
    expect(undoDepth(noteState('plain', { doc: body, extensions }, doc))).toBe(0)
    expectWithinBudget(context, ms, 1)
  })

  it('leaves a typed note without encoding its state in the switch', (context) => {
    const doc = replicaOf(state)
    const shown = EditorState.create({ doc: body, extensions })
    const ms = timed(() => {
      doc.getText(BODY).insert(0, 'x')
      const typed = shown.update({
        changes: { from: 0, insert: 'x' },
        userEvent: 'input.type',
        annotations: Transaction.time.of(1000),
      }).state
      keepUndo('typed', typed, doc)
    })
    expectWithinBudget(context, ms, 2)
  })

  it('shows a note again that did not change, with its history, in about a plain create', (context) => {
    const doc = replicaOf(state)
    doc.getText(BODY).insert(0, 'x')
    const text = doc.getText(BODY).toString()
    const typed = EditorState.create({ doc: body, extensions }).update({
      changes: { from: 0, insert: 'x' },
      userEvent: 'input.type',
    }).state
    const config = { doc: text, selection: EditorSelection.single(1), extensions }
    const plain = timed(() => void EditorState.create(config))
    const times: number[] = []
    for (let i = 0; i < 5; i += 1) {
      keepUndo('back', typed, doc)
      const start = performance.now()
      const shown = noteState('back', config, doc)
      times.push(performance.now() - start)
      expect(undoDepth(shown)).toBe(1)
    }
    expectWithinBudget(context, median(times), 2 * plain + 2)
  })

  it('reads the authorship of a note without copying its text', (context) => {
    const doc = replicaOf(state)
    const config = { doc: body, extensions: [authoredField(doc, 'note')] }
    const bare = timed(() => void EditorState.create({ doc: body }))
    const ms = timed(() => void EditorState.create(config))
    expectWithinBudget(context, ms, bare + 2)
  })
})

describe('the worker opening a 2 MB note', { timeout: TIMEOUT_MS }, () => {
  let storage: SqliteAdapter | undefined
  afterAll(() => storage?.close())

  it('sends a note unchanged since it was read or saved as it is', async (context) => {
    storage = openSqliteAdapter(join(tempDir('devot-note-switch-bench-'), 'devot.sqlite'))
    const notes = createNoteService({
      storage,
      clock: createClock('mac1'),
      newId: createIdGenerator(),
      saveDelayMs: 5,
    })
    const id = await notes.create('Long note')
    const typed = replicaOf(typedState())
    await notes.applyUpdate(id, Y.encodeStateAsUpdate(typed))
    await notes.flush()
    await notes.hold(id)
    await notes.open(id)
    const times: number[] = []
    for (let i = 0; i < 5; i += 1) {
      const start = performance.now()
      await notes.open(id)
      times.push(performance.now() - start)
    }
    const replica = replicaOf((await notes.open(id)).state)
    expect(replica.getText(BODY).toString()).toBe((await notes.read(id)).bodyMd)
    expectWithinBudget(context, median(times), 2)
  })
})
