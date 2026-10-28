import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  BODY,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  findBacklinks,
  noteLink,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

function setup() {
  const storage = openSqliteAdapter(join(tempDir('devot-backlinks-'), 'devot.sqlite'))
  open.push(storage)
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  return {
    storage,
    notes: createNoteService({ storage, clock, newId, saveDelayMs: 5 }),
    tags: createTagService({ storage, clock, newId }),
  }
}

async function write(notes: ReturnType<typeof setup>['notes'], id: string, text: string) {
  const opened = await notes.open(id)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, opened.state)
  const before = Y.encodeStateVector(doc)
  doc.getText(BODY).insert(0, text)
  await notes.applyUpdate(id, Y.encodeStateAsUpdate(doc, before))
  await notes.flush()
}

describe('findBacklinks', () => {
  it('finds the live notes linking to a note, never the note itself or one in the Trash', async () => {
    const { storage, notes } = setup()
    const target = await notes.create('Target')
    const linking = await notes.create('Linking')
    const trashed = await notes.create('Trashed')
    await notes.create('Unrelated')
    await write(notes, linking, `See ${noteLink('Target', target)}.`)
    await write(notes, trashed, noteLink('Target', target))
    await write(notes, target, `Myself: ${noteLink('Target', target)}`)
    await notes.trash(trashed)

    const found = await findBacklinks(storage, target)
    expect(found.map((n) => n.title)).toEqual(['Linking'])
    expect((await notes.backlinks(target)).map((n) => n.id)).toEqual([linking])
  })

  it('finds nothing for a note no other note links to', async () => {
    const { storage, notes } = setup()
    const id = await notes.create('Alone')
    expect(await findBacklinks(storage, id)).toEqual([])
  })
})

describe('linkTargets', () => {
  it('gives each live target its title, status, task progress and tags', async () => {
    const { notes, tags } = setup()
    const target = await notes.create('Plan')
    const gone = await notes.create('Gone')
    await write(notes, target, '- [x] one\n- [ ] two')
    await notes.setStatus(target, 'active')
    await tags.addToNote(target, 'work')
    await notes.trash(gone)

    expect(await notes.linkTargets([target, gone])).toEqual({
      [target]: {
        title: 'Plan',
        status: 'active',
        tasks: { done: 1, total: 2 },
        tags: [{ name: 'work', color: null }],
        updatedAt: expect.any(Number),
      },
    })
  })

  it('gives a target a new updatedAt with each change to it, so its chip is drawn again', async () => {
    const { notes } = setup()
    const target = await notes.create('Plan')
    const before = (await notes.linkTargets([target]))[target]!.updatedAt
    await notes.setStatus(target, 'active')
    expect((await notes.linkTargets([target]))[target]!.updatedAt).toBeGreaterThan(before)
  })
})
