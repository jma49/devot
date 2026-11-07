import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { BODY, createClock, createIdGenerator, createNoteService } from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

async function setup(body: string) {
  const storage = openSqliteAdapter(join(tempDir('devot-note-open-'), 'devot.sqlite'))
  open.push(storage)
  const options = { storage, clock: createClock('mac1'), newId: createIdGenerator() }
  const maker = createNoteService({ ...options, saveDelayMs: 5 })
  const id = await maker.create('Plan')
  await maker.setBody(id, body)
  await maker.release(id)
  const notes = createNoteService({ ...options, saveDelayMs: 60_000 })
  return { notes, id, storage }
}

const textOf = (state: Uint8Array) => {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  return doc.getText(BODY).toString()
}

/** An edit typed in an editor that shows the note opened as `state`. */
function typed(state: Uint8Array, text: string) {
  const editor = new Y.Doc()
  Y.applyUpdate(editor, state)
  const before = Y.encodeStateVector(editor)
  editor.getText(BODY).insert(0, text)
  return Y.encodeStateAsUpdate(editor, before)
}

describe('opening a note in the core', () => {
  it('sends the state it read while the note has not changed', async () => {
    const { notes, id } = await setup('Plan\n')
    await notes.hold(id)
    const first = await notes.open(id)
    const again = await notes.open(id)
    expect(again.state).toBe(first.state)
    expect(textOf(again.state)).toBe('Plan\n')
  })

  it('sends only the state when storage reads it as part of a larger frame', async () => {
    const { notes, id, storage } = await setup('Plan\n')
    const read = storage.openNote.bind(storage)
    storage.openNote = async (noteId) => {
      const opened = await read(noteId)
      if (!opened) return null
      const frame = new Uint8Array(opened.ydoc.byteLength + 64)
      frame.set(opened.ydoc, 64)
      return { ...opened, ydoc: frame.subarray(64) }
    }
    await notes.hold(id)
    const { state } = await notes.open(id)
    expect(state.byteLength).toBe(state.buffer.byteLength)
    expect(textOf(state)).toBe('Plan\n')
  })

  it('sends every change made since, saved or not', async () => {
    const { notes, id } = await setup('Plan\n')
    await notes.hold(id)
    const read = await notes.open(id)
    await notes.applyUpdate(id, typed(read.state, 'One '))
    const edited = await notes.open(id)
    expect(textOf(edited.state)).toBe('One Plan\n')
    await notes.flush()
    const saved = await notes.open(id)
    expect(textOf(saved.state)).toBe('One Plan\n')
    expect((await notes.open(id)).state).toBe(saved.state)
    await notes.setBody(id, 'Two\n')
    expect(textOf((await notes.open(id)).state)).toBe('Two\n')
  })

  it('sends what a known state lacks only', async () => {
    const { notes, id } = await setup('Plan\n')
    await notes.hold(id)
    const read = await notes.open(id)
    const editor = new Y.Doc()
    Y.applyUpdate(editor, read.state)
    const known = Y.encodeStateVector(editor)
    await notes.applyUpdate(id, typed(read.state, 'One '))
    const missing = await notes.open(id, known)
    expect(missing.state.byteLength).toBeLessThan(read.state.byteLength)
    Y.applyUpdate(editor, missing.state)
    expect(editor.getText(BODY).toString()).toBe('One Plan\n')
  })
})
