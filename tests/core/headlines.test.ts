import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createClock, createIdGenerator, createNoteService } from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

function setup() {
  const storage = openSqliteAdapter(join(tempDir('devot-headlines-'), 'devot.sqlite'))
  open.push(storage)
  const newId = createIdGenerator()
  const notes = createNoteService({ storage, clock: createClock('mac1'), newId, saveDelayMs: 5 })
  return { notes, storage }
}

describe('headlines', () => {
  it('gives each note the first line of its body, whether it has a title or not', async () => {
    const { notes } = setup()
    const a = await notes.create('')
    const b = await notes.create('Named')
    await notes.setBody(a, '# Shopping list\n\nmilk')
    await notes.setBody(b, 'Other text')
    await notes.flush()
    expect(await notes.headlines([a, b])).toEqual({ [a]: 'Shopping list', [b]: 'Other text' })
  })

  it('includes typing that is not saved yet', async () => {
    const { notes } = setup()
    const id = await notes.create('')
    await notes.setBody(id, 'just typed')
    expect(await notes.headlines([id])).toEqual({ [id]: 'just typed' })
  })

  it('is empty for a note with no text, and leaves out notes that do not exist', async () => {
    const { notes } = setup()
    const id = await notes.create('')
    expect(await notes.headlines([id, '0192a6f0-0000-7000-8000-00000000000a'])).toEqual({
      [id]: '',
    })
  })

  it('reads a note in the Trash too, and leaves the note out of memory', async () => {
    const { notes } = setup()
    const id = await notes.create('')
    await notes.setBody(id, 'Gone soon')
    await notes.trash(id)
    expect(await notes.headlines([id])).toEqual({ [id]: 'Gone soon' })
  })
})

describe('excerpts', () => {
  it('gives the readable start of the body; an untitled note skips its headline', async () => {
    const { notes } = setup()
    const a = await notes.create('')
    const b = await notes.create('Named')
    await notes.setBody(a, '# Shopping list\n\nmilk and **eggs**')
    await notes.setBody(b, '---\ntags: x\n---\nSome *plain* text')
    expect(await notes.excerpts([a, b, '0192a6f0-0000-7000-8000-00000000000a'])).toEqual({
      [a]: 'milk and eggs',
      [b]: 'Some plain text',
    })
  })
})

describe('progress', () => {
  it('counts each note’s tasks done, and is empty for a note with none', async () => {
    const { notes } = setup()
    const a = await notes.create('Chores')
    const b = await notes.create('Plain')
    await notes.setBody(a, '- [x] dishes\n- [ ] laundry\n- [ ] bins\n- [ ] floor')
    await notes.setBody(b, 'no tasks here')
    expect(await notes.progress([a, b, '0192a6f0-0000-7000-8000-00000000000a'])).toEqual({
      [a]: '1/4',
      [b]: '',
    })
  })
})
