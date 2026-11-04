import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { BODY, type OpenedRecord } from '../../src/core'
import { openedFrame, openedNote } from '../../src/renderer/src/storage/wire'
import { expectWithinBudget } from '../support/budget'

const ID = '0192a6f0-0000-7000-8000-000000000001'

/** A long note typed a line at a time, so its state carries its history. */
function longNote(lines: number): OpenedRecord {
  const doc = new Y.Doc()
  const text = doc.getText(BODY)
  for (let i = 0; i < lines; i += 1) {
    text.insert(text.length, `Line ${i} of a long note, with some words to make it wide.\n`)
  }
  return {
    id: ID,
    title: 'Long',
    titleHlc: '0001728000000000-0000-node',
    ydoc: Y.encodeStateAsUpdate(doc),
    bodyVersion: 3,
    bookId: null,
    bookHlc: '',
    status: 'none',
    statusHlc: '',
    pinned: false,
    pinnedHlc: '',
    createdAt: 1,
    updatedAt: 2,
    datesHlc: '',
    deletedAt: null,
    deletedHlc: null,
  }
}

describe('opening a note for its editor', () => {
  it('reads the note as it was stored, without its body', () => {
    const note = longNote(20)
    expect(openedNote(openedFrame(note))).toEqual(note)
    expect(openedNote(openedFrame(null))).toBeNull()
  })

  it('takes a long note’s state as it came, reading only its fields', (context) => {
    const note = longNote(40_000)
    const frame = openedFrame(note)
    expect(frame.byteLength).toBeLessThan(note.ydoc.length + 1_000)
    const start = performance.now()
    const opened = openedNote(frame)
    const ms = performance.now() - start
    expect(opened?.ydoc.buffer).toBe(frame)
    expectWithinBudget(context, ms, 2)
  })
})
