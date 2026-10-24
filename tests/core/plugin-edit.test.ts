// A plugin's edit of the open note (ADR 0005), on real SQLite: a diff applied through the note service as one update the editor
// applies as one undo step, with the text before kept as a version, and refused when the note changed since the plugin read it.
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { BODY, createClock, createIdGenerator, createNoteService } from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

function service() {
  const storage = openSqliteAdapter(join(tempDir('devot-plugin-edit-'), 'devot.sqlite'))
  open.push(storage)
  const notes = createNoteService({
    storage,
    clock: createClock('mac1'),
    newId: createIdGenerator(),
  })
  return { storage, notes }
}

async function editorFor(notes: ReturnType<typeof service>['notes'], id: string) {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, (await notes.open(id)).state, 'remote')
  return { doc, text: doc.getText(BODY) }
}

describe('a plugin edit', () => {
  it('replaces the body as one update and keeps the text before as a version', async () => {
    const { storage, notes } = service()
    const id = await notes.create('Plan')
    await notes.setBody(id, 'one two three\n')
    const editor = await editorFor(notes, id)

    const update = await notes.applyPluginEdit(id, {
      base: 'one two three\n',
      markdown: 'one TWO three\r\n',
    })
    let transactions = 0
    editor.doc.on('afterTransaction', () => (transactions += 1))
    Y.applyUpdate(editor.doc, update, 'restore')
    expect(transactions).toBe(1)
    expect(editor.text.toString()).toBe('one TWO three\n')
    await notes.flush()
    expect((await storage.getNote(id))!.bodyMd).toBe('one TWO three\n')
    const versions = (await storage.listRevisions(id)).filter((r) => r.kind === 'body')
    expect(versions.length).toBeGreaterThanOrEqual(1)
  })

  it('edits only what changed, so typing elsewhere meanwhile merges', async () => {
    const { notes } = service()
    const id = await notes.create()
    await notes.setBody(id, 'one two three')
    const editor = await editorFor(notes, id)
    const update = await notes.applyPluginEdit(id, {
      base: 'one two three',
      markdown: 'one 2 three',
    })
    editor.doc.transact(() => editor.text.insert(0, '> '))
    Y.applyUpdate(editor.doc, update, 'restore')
    expect(editor.text.toString()).toBe('> one 2 three')
  })

  it('is refused when the note changed since the plugin read it, and changes nothing', async () => {
    const { notes } = service()
    const id = await notes.create()
    await notes.setBody(id, 'typed since')
    await expect(
      notes.applyPluginEdit(id, { base: 'what it read', markdown: 'gone' }),
    ).rejects.toThrow('E_PLUGIN_NOTE_CHANGED')
    expect((await notes.read(id)).bodyMd).toBe('typed since')
  })
})
