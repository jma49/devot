// An attachment belongs to one note, but its link can reach another without a copy (cut or copied
// Markdown, Paste as Plain Text, devot-mcp, a restored version, older duplicates and templates):
// purging keeps what any note still shows.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  createTemplateService,
  type NoteService,
  type StorageAdapter,
} from '../../src/core'
import { restoreLocalStorage, useMemoryLocalStorage } from '../support/local-storage'
import {
  HAND_OVER_FILES_SQL,
  openSqliteAdapter,
  type SqliteAdapter,
} from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 9])
const F = '0192a6f0-0000-7000-8000-00000000f001'
const G = '0192a6f0-0000-7000-8000-00000000f002'
const H = '0192a6f0-0000-7000-8000-00000000f003'

const open: SqliteAdapter[] = []
const services: NoteService[] = []
afterEach(async () => {
  // Saves still waiting would land on a closed database.
  for (const notes of services.splice(0)) await notes.flush()
  open.splice(0).forEach((a) => a.close())
  restoreLocalStorage()
})

function sqlite() {
  const storage = openSqliteAdapter(join(tempDir('devot-purge-files-'), 'devot.sqlite'))
  open.push(storage)
  return storage
}

function setup(saveDelayMs = 5) {
  const storage = sqlite()
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  const notes = createNoteService({ storage, clock, newId, saveDelayMs })
  services.push(notes)
  const books = createBookService({ storage, clock, newId })
  const tags = createTagService({ storage, clock, newId })
  const templates = createTemplateService({ storage, notes, books, tags, clock, newId })
  return { storage, notes, templates }
}

const shows = (...ids: string[]) => ids.map((id) => `![shot](devot://file/${id})\n`).join('')

const ownerOf = (storage: SqliteAdapter, id: string) =>
  (
    storage.db.prepare('SELECT note_id AS noteId FROM files WHERE id = ?').get(id) as
      | { noteId: string }
      | undefined
  )?.noteId

async function withImages(
  { storage, notes }: { storage: StorageAdapter; notes: NoteService },
  title: string,
  ...ids: string[]
) {
  const id = await notes.create(title)
  for (const file of ids) await storage.putFile({ id: file, noteId: id, name: 'shot.png' }, PNG)
  await notes.setBody(id, `# ${title}\n\n${shows(...ids)}`)
  await notes.flush()
  return id
}

async function noteWith(notes: NoteService, title: string, markdown: string) {
  const id = await notes.create(title)
  await notes.setBody(id, markdown)
  await notes.flush()
  return id
}

async function purge(notes: NoteService, id: string) {
  await notes.trash(id)
  await notes.purge(id)
}

describe('purging a note', () => {
  it('leaves no text of the note in the database file, as the app does (secure_delete)', async () => {
    const s = setup()
    const marker = 'Confidential-plan-'
    const id = await noteWith(s.notes, 'Gone', marker.repeat(400))
    await noteWith(s.notes, 'Kept', 'Stays.\n')
    await purge(s.notes, id)
    await s.notes.flush()
    const path = s.storage.db.name
    open.splice(open.indexOf(s.storage), 1)
    s.storage.close()
    expect(readFileSync(path).includes(Buffer.from(marker))).toBe(false)
  })

  it('keeps an image whose link was cut into another note, and its bytes', async () => {
    const s = setup()
    const source = await withImages(s, 'Source', F)
    const target = await s.notes.create('Target')
    await s.notes.setBody(source, '# Source\n')
    await s.notes.setBody(target, `Moved ![shot](devot://file/${F}#half)`)
    await s.notes.flush()

    await s.notes.trash(source)
    expect(await s.notes.emptyTrash()).toBe(1)
    expect(ownerOf(s.storage, F)).toBe(target)
    const file = s.storage.db.prepare('SELECT name, mime, data FROM files WHERE id = ?').get(F) as {
      name: string
      mime: string
      data: Buffer
    }
    expect(file).toMatchObject({ name: 'shot.png', mime: 'image/png' })
    expect(new Uint8Array(file.data)).toEqual(PNG)

    await purge(s.notes, target)
    expect(ownerOf(s.storage, F)).toBeUndefined()
  })

  it('keeps an image a note in the Trash shows, until that note is purged too', async () => {
    const s = setup()
    const source = await withImages(s, 'Source', F)
    const copy = await noteWith(s.notes, 'Copy', shows(F))
    await s.notes.trash(copy)

    await purge(s.notes, source)
    expect(ownerOf(s.storage, F)).toBe(copy)
    await s.notes.restore(copy)
    expect(ownerOf(s.storage, F)).toBe(copy)
    await s.notes.trash(copy)
    await s.notes.emptyTrash()
    expect(ownerOf(s.storage, F)).toBeUndefined()
  })

  it('hands an image to a live note first, then to the smallest ID', async () => {
    const s = setup()
    const source = await withImages(s, 'Source', F)
    // IDs grow in creation order: the note in the Trash has the smallest.
    const trashed = await noteWith(s.notes, 'Trashed', shows(F))
    const first = await noteWith(s.notes, 'First', shows(F))
    await noteWith(s.notes, 'Second', shows(F))
    await s.notes.trash(trashed)

    await purge(s.notes, source)
    expect(ownerOf(s.storage, F)).toBe(first)
  })

  it('emptying the Trash deletes only the images no note left shows', async () => {
    const s = setup()
    const source = await withImages(s, 'Source', F, G, H)
    const trashed = await noteWith(s.notes, 'Trashed', shows(F, G))
    const kept = await noteWith(s.notes, 'Kept', shows(G))
    // Whichever is purged first, F goes: only notes in the Trash show it.
    await s.notes.trash(trashed)
    await s.notes.trash(source)

    expect(await s.notes.emptyTrash()).toBe(2)
    expect(ownerOf(s.storage, F)).toBeUndefined()
    expect(ownerOf(s.storage, G)).toBe(kept)
    expect(ownerOf(s.storage, H)).toBeUndefined()
  })

  it('keeps the images duplicates and notes from templates still share from before they were copied', async () => {
    const s = setup()
    // Notes made before Duplicate and templates copied images show the original's files.
    const original = await withImages(s, 'Original', F)
    const duplicate = await noteWith(s.notes, 'Original', shows(F))
    const template = await s.templates.create('Shot')
    await s.storage.putFile({ id: G, noteId: template, name: 'shot.png' }, PNG)
    await s.notes.setBody(template, `# {{title}}\n\n![shot](devot://file/${G}#half)\n`)
    await s.notes.flush()
    const fromTemplate = await noteWith(
      s.notes,
      'Shot',
      `# Shot\n\n![shot](devot://file/${G}#half)\n`,
    )

    await purge(s.notes, original)
    await purge(s.notes, template)
    expect(ownerOf(s.storage, F)).toBe(duplicate)
    expect(ownerOf(s.storage, G)).toBe(fromTemplate)
  })

  it('counts a link pasted a moment before, while its save is still waiting', async () => {
    // Saves wait a minute here: only the purge itself can write the paste.
    const s = setup(60_000)
    const one = await withImages(s, 'One', F)
    const two = await withImages(s, 'Two', G)
    const target = await noteWith(s.notes, 'Target', 'Empty so far')
    await s.notes.setBody(target, `Pasted ${shows(F)}`)

    await purge(s.notes, one)
    expect(ownerOf(s.storage, F)).toBe(target)
    await s.notes.trash(two)
    await s.notes.setBody(target, `Pasted ${shows(F, G)}`)
    await s.notes.emptyTrash()
    expect(ownerOf(s.storage, G)).toBe(target)
  })

  it('counts only the address as written: not in capitals, cut short or in a title', async () => {
    const s = setup()
    const source = await withImages(s, 'Source', F)
    await noteWith(s.notes, `devot://file/${F}`, 'The address is in the title only')
    await noteWith(
      s.notes,
      'Near',
      `DEVOT://FILE/${F.toUpperCase()} devot://file/${F.slice(0, 30)} file/${F} ${F}`,
    )

    await purge(s.notes, source)
    expect(ownerOf(s.storage, F)).toBeUndefined()
  })
})

describe('purging a note and revision history', () => {
  async function historyWithImage(s: ReturnType<typeof setup>, now: string) {
    const source = await withImages(s, 'Source', F)
    const other = await s.notes.create('Other')
    await s.notes.setBody(other, `With ${shows(F)}`)
    await s.notes.flush({ versions: true })
    await s.notes.setBody(other, now)
    await s.notes.flush({ versions: true })
    const versions = (await s.notes.history(other)).filter((e) => e.kind === 'body')
    const older = versions.find((v) => v.kind === 'body' && v.length > now.length)
    if (!older) throw new Error('no older version')
    return { source, other, older: older.id }
  }

  it('keeps an image a restored version shows again', async () => {
    const s = setup()
    const { source, other, older } = await historyWithImage(s, 'Without')
    await s.notes.restoreRevision(other, older)
    await s.notes.flush()

    await purge(s.notes, source)
    expect(ownerOf(s.storage, F)).toBe(other)
  })

  it('does not keep an image only an older version shows', async () => {
    const s = setup()
    const { source, other, older } = await historyWithImage(s, 'Without')

    await purge(s.notes, source)
    expect(ownerOf(s.storage, F)).toBeUndefined()
    // Restoring that version brings the link back, not the image.
    await s.notes.restoreRevision(other, older)
    await s.notes.flush()
    expect((await s.storage.getNote(other))?.bodyMd).toBe(`With ${shows(F)}`)
    expect(ownerOf(s.storage, F)).toBeUndefined()
  })
})

describe('the statement that hands images over', () => {
  it('runs the same statement as the Rust store', () => {
    const rust = readFileSync('src-tauri/src/storage/mod.rs', 'utf8')
    const statement = /const HAND_OVER_FILES_SQL: &str =\s*r#"([^#]*)"#;/.exec(rust)?.[1] ?? ''
    const words = (sql: string) => sql.split(/\s+/).join(' ').trim()
    expect(words(statement)).toBe(words(HAND_OVER_FILES_SQL))
  })

  it('finds the notes that show an image through the search index, never by reading every note', () => {
    const storage = sqlite()
    const plan = (
      storage.db.prepare(`EXPLAIN QUERY PLAN ${HAND_OVER_FILES_SQL}`).all({ id: F }) as {
        detail: string
      }[]
    )
      .map((p) => p.detail)
      .join('\n')
    expect(plan).toMatch(/SEARCH files USING INDEX files_by_note \(note_id=\?\)/)
    expect(plan).toMatch(/SCAN notes_fts VIRTUAL TABLE INDEX \d+:M/)
    expect(plan).toMatch(/SEARCH n USING INTEGER PRIMARY KEY \(rowid=\?\)/)
    expect(plan).not.toMatch(/SCAN (n|notes)\b/)
  })
})

describe('the UI tests’ memory adapter', () => {
  it('keeps and hands over images like SQLite', async () => {
    useMemoryLocalStorage()
    const { memoryStorage } = await import('../../src/renderer/src/storage/memory')
    const run = async (storage: StorageAdapter) => {
      const notes = createNoteService({
        storage,
        clock: createClock('mac1'),
        newId: createIdGenerator(),
        saveDelayMs: 5,
      })
      services.push(notes)
      const source = await withImages({ storage, notes }, 'Source', F, G, H)
      const trashed = await noteWith(notes, 'Trashed', shows(F, G))
      const live = await noteWith(notes, 'Live', `At a size ![](devot://file/${F}#half)`)
      const near = await noteWith(notes, 'Near', `DEVOT://FILE/${H.toUpperCase()}`)
      await notes.trash(trashed)
      const owners = async () => {
        const rows =
          storage === memoryStorage
            ? (JSON.parse(localStorage.getItem('devot.test.files') ?? '[]') as {
                id: string
                noteId: string
              }[])
            : ((storage as SqliteAdapter).db
                .prepare('SELECT id, note_id AS noteId FROM files')
                .all() as { id: string; noteId: string }[])
        const names = new Map([
          [source, 'source'],
          [trashed, 'trashed'],
          [live, 'live'],
          [near, 'near'],
        ])
        return Object.fromEntries(
          rows.map((r) => [r.id, names.get(r.noteId) ?? r.noteId] as const).sort(),
        )
      }
      await purge(notes, source)
      const afterPurge = await owners()
      await notes.emptyTrash()
      return { afterPurge, afterEmpty: await owners() }
    }
    const fromSqlite = await run(sqlite())
    const fromMemory = await run(memoryStorage)
    expect(fromSqlite).toEqual({
      afterPurge: { [F]: 'live', [G]: 'trashed' },
      afterEmpty: { [F]: 'live' },
    })
    expect(fromMemory).toEqual(fromSqlite)
  })
})
