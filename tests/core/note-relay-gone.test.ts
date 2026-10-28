// A note trashed or purged in one window reaches the others as `gone`, so a note window turns
// read-only instead of writing into a note storage no longer takes (A037, A061).
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
})
