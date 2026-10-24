// Accepting an AI edit proposal, on real SQLite: the text goes in as a diff through the note service, as one update the
// editor applies as one undo step, with the text before kept as a version and the result as a version marked as AI's.
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import {
  AI_EDIT,
  BODY,
  createClock,
  createIdGenerator,
  createNoteService,
  KEEP_NEWEST,
  REVISION_PAUSE_MS,
  revisionsToDrop,
  type NoteService,
  type RevisionRecord,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const DAY = 86_400_000
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
  for (let left = ms; left > 0; left -= 1000) {
    time += Math.min(1000, left)
    await vi.advanceTimersByTimeAsync(Math.min(1000, left))
  }
}

function service() {
  const storage = openSqliteAdapter(join(tempDir('devot-ai-edit-'), 'devot.sqlite'))
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

async function bodies(storage: SqliteAdapter, id: string) {
  const found = (await storage.listRevisions(id)).filter((r) => r.kind === 'body')
  return Promise.all(
    found.map(async (r) => ({
      value: r.value,
      text: textOf(await storage.getRevision(r.id)),
    })),
  )
}

describe('accepting a proposal', () => {
  it('applies it as one update and keeps the text before and the text after', async () => {
    const { storage, notes } = service()
    const id = await notes.create('Plan')
    const editor = await editorFor(notes, id)
    await editor.type('# Plan\n\nTeh first draft.\n\nEnd\n')
    const from = '# Plan\n\n'.length

    const update = await notes.applyAiEdit(id, {
      from,
      original: 'Teh first draft.',
      replacement: 'The first draft.',
    })
    let transactions = 0
    editor.doc.on('afterTransaction', () => (transactions += 1))
    Y.applyUpdate(editor.doc, update, 'restore')
    expect(transactions).toBe(1)
    expect(editor.text.toString()).toBe('# Plan\n\nThe first draft.\n\nEnd\n')
    await notes.flush()
    expect((await storage.getNote(id))!.bodyMd).toBe('# Plan\n\nThe first draft.\n\nEnd\n')

    // Newest first: what AI wrote, marked, then the typing it replaced.
    expect(await bodies(storage, id)).toEqual([
      { value: AI_EDIT, text: '# Plan\n\nThe first draft.\n\nEnd\n' },
      { value: null, text: '# Plan\n\nTeh first draft.\n\nEnd\n' },
    ])
    const [ai, typed] = await notes.history(id)
    expect(ai).toMatchObject({ kind: 'body', ai: true })
    expect(typed).not.toHaveProperty('ai')
  })

  it('edits only the characters that changed, so typing elsewhere merges', async () => {
    const { notes } = service()
    const id = await notes.create()
    const editor = await editorFor(notes, id)
    await editor.type('one two three')
    const update = await notes.applyAiEdit(id, {
      from: 4,
      original: 'two',
      replacement: 'TWO',
    })
    // Typed in the editor before the update arrived.
    editor.doc.transact(() => editor.text.insert(0, '> '))
    Y.applyUpdate(editor.doc, update, 'restore')
    expect(editor.text.toString()).toBe('> one TWO three')
  })

  it('finds the selection where edits since moved it, when it is there once', async () => {
    const { notes } = service()
    const id = await notes.create()
    const editor = await editorFor(notes, id)
    await editor.type('intro\nold text\n')
    const from = 'intro\n'.length
    await editor.type('a longer intro\nold text\n')
    const update = await notes.applyAiEdit(id, {
      from,
      original: 'old text',
      replacement: 'new',
    })
    Y.applyUpdate(editor.doc, update, 'restore')
    expect(editor.text.toString()).toBe('a longer intro\nnew\n')
  })

  it('refuses when the selection changed or is no longer there alone', async () => {
    const { notes } = service()
    const id = await notes.create()
    const editor = await editorFor(notes, id)
    await editor.type('same same')
    await expect(
      notes.applyAiEdit(id, { from: 0, original: 'gone', replacement: 'x' }),
    ).rejects.toThrow('E_AI_PROPOSAL_STALE')
    await expect(
      notes.applyAiEdit(id, { from: 2, original: 'same', replacement: 'x' }),
    ).rejects.toThrow('E_AI_PROPOSAL_STALE')
    expect(editor.text.toString()).toBe('same same')
  })

  it('keeps the text from before the session when nothing was typed yet', async () => {
    const { storage, notes } = service()
    const id = await notes.create()
    await notes.setBody(id, 'stored text')
    await notes.flush({ versions: true })
    await advance(REVISION_PAUSE_MS)
    await notes.applyAiEdit(id, {
      from: 0,
      original: 'stored',
      replacement: 'kept',
    })
    await notes.flush()
    expect((await bodies(storage, id)).map((b) => b.text)).toEqual(['kept text', 'stored text'])
  })

  it('stays out of the activity heatmap, and typing after it counts from it', async () => {
    const { notes } = service()
    const id = await notes.create()
    const editor = await editorFor(notes, id)
    const today = Math.floor(time / DAY)
    const charsToday = async () =>
      (await notes.activity(time, () => 0)).days.find((d) => d.day === today)?.chars
    await editor.type('short')
    await notes.flush({ versions: true })
    expect(await charsToday()).toBe(5)

    const rewritten = 'a much longer text by AI'
    Y.applyUpdate(
      editor.doc,
      await notes.applyAiEdit(id, { from: 0, original: 'short', replacement: rewritten }),
      'restore',
    )
    await notes.flush({ versions: true })
    expect(await charsToday()).toBe(5)

    await advance(REVISION_PAUSE_MS)
    await editor.type(`${rewritten}!!`)
    await notes.flush({ versions: true })
    expect(await charsToday()).toBe(7)
  })

  it('is never thinned by compaction', () => {
    const at = Date.UTC(2026, 0, 1)
    // One day's versions, older than a week: all but the last of the day would go.
    const versions = Array.from({ length: KEEP_NEWEST + 5 }, (_, n) => ({
      id: `v${n}`,
      kind: 'body' as const,
      at: at + n * 1000,
      value: n === 1 ? AI_EDIT : null,
    }))
    const newer = {
      id: 'new',
      kind: 'body' as const,
      at: at + 30 * DAY,
      value: null,
    }
    const dropped = revisionsToDrop([...versions, newer], at + 30 * DAY)
    expect(dropped).toContain('v2')
    expect(dropped).not.toContain('v1')
  })
})
