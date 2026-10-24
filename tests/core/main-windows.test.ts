// Several main windows (#9) each run a core on one library, and every one of them may hold the same
// note. Text and titles reach the others through the relay, as between a main window and a note window;
// a status, a pin or a notebook one window sets reaches the others when they merge what is stored (what
// they do after `lists-changed`, see mainWindows.ts).
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { BODY, type StorageAdapter } from '../../src/core'
import { windowsOn } from '../support/note-windows'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

function sqlite() {
  const storage = openSqliteAdapter(join(tempDir('devot-mains-'), 'devot.sqlite'))
  open.push(storage)
  return storage
}

async function twoMains(body = 'Plan\n', storage: StorageAdapter = sqlite()) {
  const [setup] = windowsOn(storage, ['setup']).windows
  const id = await setup!.notes.create('Plan')
  await setup!.notes.setBody(id, body)
  await setup!.notes.release(id)
  const app = windowsOn(storage, ['main1', 'main2'])
  const [first, second] = app.windows as [(typeof app.windows)[0], (typeof app.windows)[0]]
  return { ...app, first, second, id, storage }
}

const append = (editor: Y.Doc, text: string) => {
  const body = editor.getText(BODY)
  body.insert(body.length, text)
}

describe('two main windows on one note', () => {
  it('see each other’s typing at once, in both directions', async () => {
    const w = await twoMains()
    const firstEditor = await w.show(w.first, w.id)
    const secondEditor = await w.show(w.second, w.id)
    await w.deliverAll()
    append(secondEditor, 'From the second\n')
    await w.deliverAll()
    expect(w.editorText(w.first, w.id)).toBe('Plan\nFrom the second\n')
    append(firstEditor, 'From the first\n')
    await w.deliverAll()
    expect(w.editorText(w.second, w.id)).toBe('Plan\nFrom the second\nFrom the first\n')
  })

  it('end with every edit either made, saved by both', async () => {
    const w = await twoMains()
    const firstEditor = await w.show(w.first, w.id)
    const secondEditor = await w.show(w.second, w.id)
    await w.deliverAll()
    append(firstEditor, 'one\n')
    append(secondEditor, 'two\n')
    await w.settle()
    await w.first.notes.flush()
    await w.second.notes.flush()
    await w.deliverAll()
    await w.first.notes.flush()
    await w.second.notes.flush()
    const text = (await w.storage.getNote(w.id))!.bodyMd
    expect(text).toContain('one')
    expect(text).toContain('two')
    expect(w.editorText(w.first, w.id)).toBe(w.editorText(w.second, w.id))
    expect(w.editorText(w.first, w.id)).toBe(text)
  })

  it('show a title one of them changed in the other', async () => {
    const w = await twoMains()
    await w.show(w.first, w.id)
    await w.show(w.second, w.id)
    await w.deliverAll()
    await w.first.notes.setTitle(w.id, 'Renamed')
    await w.deliverAll()
    expect(w.second.titles.get(w.id)).toBe('Renamed')
  })
})

describe('what one main window changes besides the text', () => {
  it('reaches the other when it merges what is stored, and a later save of the other keeps it', async () => {
    const w = await twoMains()
    const secondEditor = await w.show(w.second, w.id)
    await w.deliverAll()
    await w.first.notes.setStatus(w.id, 'active')
    await w.first.notes.setPinned(w.id, true)
    await w.first.notes.flush()

    await w.second.notes.mergeStored()
    const listed = (await w.second.notes.list()).find((note) => note.id === w.id)
    expect(listed).toMatchObject({ status: 'active', pinned: true })

    append(secondEditor, 'More\n')
    await w.settle()
    await w.second.notes.flush()
    expect(await w.storage.getNote(w.id)).toMatchObject({ status: 'active', pinned: true })
  })

  it('shows a note the other made, and one it trashed', async () => {
    const w = await twoMains()
    const made = await w.first.notes.create('Second note')
    await w.first.notes.flush()
    await w.second.notes.mergeStored()
    expect((await w.second.notes.list()).map((note) => note.id)).toContain(made)

    await w.first.notes.trash(w.id)
    await w.first.notes.flush()
    await w.second.notes.mergeStored()
    expect((await w.second.notes.list()).map((note) => note.id)).not.toContain(w.id)
    expect((await w.second.notes.listTrash()).map((note) => note.id)).toContain(w.id)
  })
})
