// A note trashed or purged in one window reaches the others as `gone`, so a note window turns
// read-only instead of writing into a note storage no longer takes (A037, A061).
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { StorageAdapter } from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'
import { windowsOn } from '../support/note-windows'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

function twoWindows() {
  const storage = openSqliteAdapter(join(tempDir('devot-gone-'), 'devot.sqlite'))
  open.push(storage)
  return windowsOn(storage, ['main', 'note'])
}

describe('a note that leaves the library', () => {
  it('tells the other windows it went to the Trash, then that it was purged', async () => {
    const { windows, deliverAll } = twoWindows()
    const [main, note] = windows as [(typeof windows)[number], (typeof windows)[number]]
    const id = await main.notes.create('Doomed')
    await note.notes.open(id)
    note.inbox.length = 0

    await main.notes.trash(id)
    expect(note.inbox).toContainEqual({ kind: 'gone', noteId: id, purged: false })
    await deliverAll()
    expect(note.inbox).toEqual([])

    await main.notes.purge(id)
    expect(note.inbox).toContainEqual({ kind: 'gone', noteId: id, purged: true })
    // Taking it in is harmless: the note window turns read-only from the message itself.
    await deliverAll()
    expect(note.inbox).toEqual([])
  })

  it('tells a window about each note Empty Trash purges', async () => {
    const { windows, deliverAll } = twoWindows()
    const [main, note] = windows as [(typeof windows)[number], (typeof windows)[number]]
    const first = await main.notes.create('One')
    const second = await main.notes.create('Two')
    await note.notes.open(first)
    await note.notes.open(second)
    await main.notes.trash(first)
    await main.notes.trash(second)
    note.inbox.length = 0

    expect(await main.notes.emptyTrash()).toBe(2)
    const gone = note.inbox.filter((m) => m.kind === 'gone')
    expect(gone.map((m) => (m.kind === 'gone' ? m.noteId : '')).sort()).toEqual(
      [first, second].sort(),
    )
    expect(gone.every((m) => m.kind === 'gone' && m.purged)).toBe(true)
    await deliverAll()
  })

  it('tells a window about each note Empty Trash purged before a purge failed', async () => {
    const sqlite = openSqliteAdapter(join(tempDir('devot-gone-'), 'devot.sqlite'))
    open.push(sqlite)
    const purged: string[] = []
    const storage: StorageAdapter = Object.assign(Object.create(sqlite) as SqliteAdapter, {
      async purgeNote(...args: Parameters<StorageAdapter['purgeNote']>) {
        if (purged.length > 0) throw new Error('E_TEST_PURGE')
        await sqlite.purgeNote(...args)
        purged.push(args[0])
      },
    })
    const { windows, deliverAll } = windowsOn(storage, ['main', 'note'])
    const [main, note] = windows as [(typeof windows)[number], (typeof windows)[number]]
    const first = await main.notes.create('One')
    const second = await main.notes.create('Two')
    await note.notes.open(first)
    await note.notes.open(second)
    await main.notes.trash(first)
    await main.notes.trash(second)
    note.inbox.length = 0

    await expect(main.notes.emptyTrash()).rejects.toThrow('E_TEST_PURGE')
    expect(purged).toHaveLength(1)
    expect(note.inbox).toEqual([{ kind: 'gone', noteId: purged[0], purged: true }])
    await deliverAll()
  })
})
