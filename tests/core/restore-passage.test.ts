import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import {
  BODY,
  createClock,
  createIdGenerator,
  charsChanged,
  createNoteService,
  inlineDiff,
  passageInserts,
  REVISION_PAUSE_MS,
  type NoteService,
  type RevisionRecord,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
let time = Date.UTC(2026, 9, 10, 12)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  time = Date.UTC(2026, 9, 10, 12)
})
afterEach(() => {
  vi.useRealTimers()
  open.splice(0).forEach((a) => a.close())
})

async function advance(ms: number) {
  const step = 1000
  for (let left = ms; left > 0; left -= step) {
    time += Math.min(step, left)
    await vi.advanceTimersByTimeAsync(Math.min(step, left))
  }
}

function service() {
  const storage = openSqliteAdapter(join(tempDir('devot-passage-'), 'devot.sqlite'))
  open.push(storage)
  const notes = createNoteService({
    storage,
    clock: createClock('mac1'),
    newId: createIdGenerator(),
    now: () => time,
    saveDelayMs: 300,
  })
  return { storage, notes }
}

async function editorFor(notes: NoteService, id: string) {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, (await notes.open(id)).state, 'remote')
  const pending: Promise<void>[] = []
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'remote' && origin !== 'restore') pending.push(notes.applyUpdate(id, update))
  })
  const text = doc.getText(BODY)
  return {
    doc,
    text,
    async type(next: string) {
      doc.transact(() => {
        text.delete(0, text.length)
        text.insert(0, next)
      })
      await Promise.all(pending)
    },
  }
}

const textOf = (revision: RevisionRecord | null) => {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, revision!.ydoc!)
  return doc.getText(BODY).toString()
}

describe('inlineDiff', () => {
  it('shows the text kept, removed and added in reading order', () => {
    expect(inlineDiff('one two three\nfour\n', 'one 2 three\nfour\nfive\n')).toEqual([
      { kind: 'same', text: 'one ' },
      { kind: 'removed', text: 'two' },
      { kind: 'added', text: '2' },
      { kind: 'same', text: ' three\nfour\n' },
      { kind: 'added', text: 'five\n' },
    ])
  })

  it('is one run for equal texts and none for two empty ones', () => {
    expect(inlineDiff('same', 'same')).toEqual([{ kind: 'same', text: 'same' }])
    expect(inlineDiff('', '')).toEqual([])
    expect(inlineDiff('gone', '')).toEqual([{ kind: 'removed', text: 'gone' }])
  })

  it('keeps every character of both texts', () => {
    const from = 'alpha\nbeta \u{1f600}\ngamma\ndelta\n'
    const to = 'alpha\nBETA \u{1f600}\ndelta\nepsilon'
    const segments = inlineDiff(from, to)
    const textOf = (kinds: string[]) =>
      segments
        .filter((s) => kinds.includes(s.kind))
        .map((s) => s.text)
        .join('')
    expect(textOf(['same', 'removed'])).toBe(from)
    expect(textOf(['same', 'added'])).toBe(to)
  })
})

describe('passageInserts', () => {
  it('puts back the removed part of a range where it stood', () => {
    const from = 'keep this, drop this, keep that'
    const to = 'keep this, keep that'
    const start = from.indexOf('drop')
    expect(passageInserts(from, to, start, start + 'drop this, '.length)).toEqual([
      { at: 'keep this, '.length, text: 'drop this, ' },
    ])
  })

  it('leaves out text the note still has, and puts a removal before its replacement', () => {
    const from = 'a old b'
    const to = 'a new b and more'
    expect(passageInserts(from, to, 0, from.length)).toEqual([{ at: 2, text: 'old ' }])
  })

  it('takes each removed run a range overlaps, in the offsets of the current text', () => {
    const from = 'one\ntwo\nthree\nfour\n'
    const to = 'ONE\none\nthree\n'
    expect(passageInserts(from, to, 0, from.length)).toEqual([
      { at: 8, text: 'two\n' },
      { at: 14, text: 'four\n' },
    ])
    expect(passageInserts(from, to, 0, 4)).toEqual([])
    expect(passageInserts(from, to, 5, 6)).toEqual([{ at: 8, text: 'two' }])
  })

  it('takes the whole of each word a dragged range ends inside', () => {
    const from = 'Day 1: walk Alfama, eat pasteis'
    const to = 'Day 1: walk Ribeira, eat francesinha.'
    const start = from.indexOf('teis')
    expect(passageInserts(from, to, start, start + 4)).toEqual([
      { at: to.indexOf('francesinha'), text: 'pasteis ' },
    ])
    const middle = from.indexOf('fama')
    expect(passageInserts(from, to, middle, middle + 2)).toEqual([
      { at: to.indexOf('Ribeira'), text: 'Alfama, ' },
    ])
  })

  it('gives a word put back before its replacement the space it stood with', () => {
    const wine = 'bring \u{1F377}.'
    expect(passageInserts(wine, 'bring cake.', 6, 8)).toEqual([{ at: 6, text: '\u{1F377} ' }])
    const cat = '\u6211\u559c\u6b22\u732b'
    expect(passageInserts(cat, '\u6211\u559c\u6b22\u72d7', 3, 4)).toEqual([
      { at: 3, text: '\u732b' },
    ])
  })
})

describe('charsChanged', () => {
  it('counts the characters each changed word removed and added, not the change in length', () => {
    expect(charsChanged('walk Lisbon now', 'walk Porto! now')).toBe(12)
    expect(charsChanged('same', 'same')).toBe(0)
    expect(charsChanged('', 'abc')).toBe(3)
    expect(charsChanged('a \u{1F377}', 'a ')).toBe(1)
  })
})

describe('restoring a passage', () => {
  async function twoVersions() {
    const setup = service()
    const id = await setup.notes.create('Plan')
    const editor = await editorFor(setup.notes, id)
    await editor.type('intro\nthe part I cut\noutro\n')
    await advance(REVISION_PAUSE_MS + 1000)
    await editor.type('intro\noutro\nnew ending\n')
    await advance(REVISION_PAUSE_MS + 1000)
    const versions = (await setup.storage.listRevisions(id)).filter((r) => r.kind === 'body')
    return { ...setup, id, editor, older: versions[1]! }
  }

  it('puts back one removed passage as one edit, kept as a new version', async () => {
    const { storage, notes, id, editor, older } = await twoVersions()
    const old = await notes.revisionText(id, older.id)
    expect(old).toBe('intro\nthe part I cut\noutro\n')
    const before = (await storage.listRevisions(id)).length
    const from = old.indexOf('the part')
    const update = await notes.restorePassage(id, older.id, {
      from,
      to: from + 'the part I cut\n'.length,
    })
    let transactions = 0
    editor.doc.on('afterTransaction', () => (transactions += 1))
    Y.applyUpdate(editor.doc, update, 'restore')
    expect(transactions).toBe(1)
    expect(editor.text.toString()).toBe('intro\nthe part I cut\noutro\nnew ending\n')
    await notes.flush()
    expect((await storage.getNote(id))!.bodyMd).toBe('intro\nthe part I cut\noutro\nnew ending\n')
    const after = (await storage.listRevisions(id)).filter((r) => r.kind === 'body')
    expect((await storage.listRevisions(id)).length).toBe(before + 1)
    expect(textOf(await storage.getRevision(after[0]!.id))).toBe(
      'intro\nthe part I cut\noutro\nnew ending\n',
    )
  })

  it('works on the text as it is now, with changes made since the version shown', async () => {
    const { notes, id, editor, older } = await twoVersions()
    // Another process (sync, devot-mcp) changed the note meanwhile.
    await notes.setBody(id, 'intro\noutro\nnew ending\nfrom elsewhere\n')
    const old = await notes.revisionText(id, older.id)
    const from = old.indexOf('cut')
    const update = await notes.restorePassage(id, older.id, { from, to: from + 'cut\n'.length })
    Y.applyUpdate(editor.doc, update, 'restore')
    const { bodyMd } = await notes.read(id)
    expect(bodyMd).toBe('intro\ncut\noutro\nnew ending\nfrom elsewhere\n')
  })

  it('keeps typing not saved yet as a version first', async () => {
    const { storage, notes, id, editor, older } = await twoVersions()
    await editor.type('intro\noutro\ntyped just now\n')
    const old = await notes.revisionText(id, older.id)
    const from = old.indexOf('the part')
    await notes.restorePassage(id, older.id, { from, to: from + 4 })
    const versions = (await storage.listRevisions(id)).filter((r) => r.kind === 'body')
    expect(textOf(await storage.getRevision(versions[1]!.id))).toBe(
      'intro\noutro\ntyped just now\n',
    )
  })

  it('counts what each version changed from the one before, the oldest none', async () => {
    const { storage, notes, id, editor } = await twoVersions()
    const versions = (await storage.listRevisions(id)).filter((r) => r.kind === 'body')
    const changes = await notes.versionChanges(id)
    expect(changes[versions[0]!.id]).toBe('the part I cut\n'.length + 'new ending\n'.length)
    expect(changes[versions.at(-1)!.id]).toBeUndefined()
    await editor.type('intro\noutro\nnew ending!\n')
    await advance(REVISION_PAUSE_MS + 1000)
    const newest = (await storage.listRevisions(id)).find((r) => r.kind === 'body')!
    expect((await notes.versionChanges(id))[newest.id]).toBe(1)
  })

  it('refuses a range the note still has, and a version of another note', async () => {
    const { notes, id, older } = await twoVersions()
    await expect(notes.restorePassage(id, older.id, { from: 0, to: 5 })).rejects.toThrow(
      'E_PASSAGE_NOT_REMOVED',
    )
    const other = await notes.create()
    await expect(notes.restorePassage(other, older.id, { from: 0, to: 30 })).rejects.toThrow(
      'E_REVISION_NOT_FOUND',
    )
    await expect(notes.revisionText(other, older.id)).rejects.toThrow('E_REVISION_NOT_FOUND')
  })
})
