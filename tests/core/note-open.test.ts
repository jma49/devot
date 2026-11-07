import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { BODY, createClock, createIdGenerator, createNoteService } from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

async function setup(...bodies: string[]) {
  const storage = openSqliteAdapter(join(tempDir('devot-note-open-'), 'devot.sqlite'))
  open.push(storage)
  const options = { storage, clock: createClock('mac1'), newId: createIdGenerator() }
  const maker = createNoteService({ ...options, saveDelayMs: 5 })
  const ids: string[] = []
  for (const body of bodies) {
    const id = await maker.create('Plan')
    await maker.setBody(id, body)
    await maker.release(id)
    ids.push(id)
  }
  const notes = createNoteService({ ...options, saveDelayMs: 60_000 })
  return { notes, id: ids[0]!, ids, storage }
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

describe('the encoded state a note keeps', () => {
  it('is sent as read to an open that holds nothing, and not kept after it', async () => {
    const { notes, id, storage } = await setup('Plan\n')
    const read = storage.openNote.bind(storage)
    let stored: Uint8Array | undefined
    storage.openNote = async (noteId) => {
      const opened = await read(noteId)
      if (!opened) return null
      stored = opened.ydoc.slice()
      return { ...opened, ydoc: stored }
    }
    const first = await notes.open(id)
    expect(first.state).toBe(stored)
    const again = await notes.open(id)
    expect(again.state).not.toBe(first.state)
    expect(textOf(again.state)).toBe('Plan\n')
  })

  it('stays with the note left last until another note is left', async () => {
    const { notes, ids } = await setup('One\n', 'Two\n')
    const [one, two] = ids as [string, string]
    await notes.hold(one)
    const shown = await notes.open(one)
    await notes.hold(two)
    await notes.open(two)
    await notes.unhold(one)
    expect((await notes.open(one)).state).toBe(shown.state)
    await notes.hold(one)
    await notes.unhold(two)
    expect((await notes.open(one)).state).toBe(shown.state)
    const left = await notes.open(two)
    expect((await notes.open(two)).state).toBe(left.state)
    await notes.unhold(one)
    expect((await notes.open(two)).state).not.toBe(left.state)
    expect((await notes.open(one)).state).toBe(shown.state)
  })

  it('is the saved state when the note left is saved after the switch', async () => {
    const { notes, ids } = await setup('One\n', 'Two\n')
    const [one, two] = ids as [string, string]
    await notes.hold(one)
    await notes.applyUpdate(one, typed((await notes.open(one)).state, 'Edit '))
    await notes.hold(two)
    await notes.open(two)
    await notes.unhold(one)
    await notes.flush()
    const back = await notes.open(one)
    expect(textOf(back.state)).toBe('Edit One\n')
    expect((await notes.open(one)).state).toBe(back.state)
  })

  it('is not kept by a note saved that no editor holds or left last', async () => {
    const { notes, ids } = await setup('One\n', 'Two\n')
    const [one, two] = ids as [string, string]
    await notes.hold(one)
    await notes.unhold(one)
    await notes.applyUpdate(two, typed((await notes.open(two)).state, 'Edit '))
    await notes.flush()
    const saved = await notes.open(two)
    expect(textOf(saved.state)).toBe('Edit Two\n')
    expect((await notes.open(two)).state).not.toBe(saved.state)
  })
})
