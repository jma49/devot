// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { applyBatch } from '../../../../core/batch'
import { createBookService } from '../../../../core/books'
import { createClock } from '../../../../core/hlc'
import { createIdGenerator } from '../../../../core/ids'
import { createNoteService } from '../../../../core/notes/service'
import { createTagService } from '../../../../core/tags'
import { createTemplateService } from '../../../../core/templates'
import { TEMPLATES_BOOK_ID } from '../../../../core/templatesBook'
import { t } from '../../i18n'
import { memoryStorage } from '../../storage/memory'
import { createCoreGate } from '../coreGate'
import { listHandlers, type ListsCore } from './lists'

function lists() {
  const storage = memoryStorage
  const clock = createClock('lists1')
  const newId = createIdGenerator()
  const notes = createNoteService({ storage, clock, newId, saveDelayMs: 5 })
  const books = createBookService({ storage, clock, newId })
  const tags = createTagService({ storage, clock, newId })
  const templates = createTemplateService({
    storage,
    notes,
    books,
    tags,
    clock,
    newId,
  })
  const core: ListsCore = {
    excerpts: (ids) => notes.excerpts(ids),
    batch: (ids, change) => applyBatch({ notes, tags }, ids, change),
    emptyTrash: () => notes.emptyTrash(),
    createTemplate: () => templates.create(),
    createBook: (name, parentId) => books.create(name, parentId),
    applyTemplate: (id, now, bookId) => templates.apply(id, { now }, bookId),
    read: (id) => notes.read(id),
    setStatusUndoable: (id, status) => notes.setStatusUndoable(id, status),
    undoStatus: (id, undo) => notes.undoStatus(id, undo),
  }
  return {
    notes,
    books,
    tags,
    core,
    handlers: listHandlers(
      async () => core,
      () => 1_800_000_000_000,
    ),
  }
}

const run = (handlers: ReturnType<typeof listHandlers>, op: keyof typeof handlers, args = {}) => {
  const handler = handlers[op]
  if (!handler) throw new Error(`no handler for ${op}`)
  return handler(args)
}

describe('the native lists operations', () => {
  it('answers the excerpts of the rows asked for', async () => {
    const { notes, handlers } = lists()
    const id = await notes.create('Groceries')
    await notes.setBody(id, 'Milk and bread for the week')
    expect(await run(handlers, 'excerpts', { ids: [id] })).toStrictEqual({
      excerpts: { [id]: expect.stringContaining('Milk and bread') },
    })
  })

  it('changes the notes picked through the core batch, and says which changed', async () => {
    const { notes, handlers } = lists()
    const first = await notes.create('First')
    const second = await notes.create('Second')
    const ids = [first, second]
    expect(
      await run(handlers, 'notes.batch', {
        ids,
        change: { kind: 'status', status: 'completed' },
      }),
    ).toStrictEqual({
      changed: ids,
      failed: [],
    })
    await run(handlers, 'notes.batch', {
      ids: [first],
      change: { kind: 'pinned', pinned: true },
    })
    const rows = new Map((await notes.summaries(ids)).map((n) => [n.id, n]))
    expect(ids.map((id) => [rows.get(id)?.status, rows.get(id)?.pinned])).toStrictEqual([
      ['completed', true],
      ['completed', false],
    ])
    await run(handlers, 'notes.batch', {
      ids: [second],
      change: { kind: 'trash' },
    })
    expect((await notes.listTrash()).map((n) => n.id)).toContain(second)
    await run(handlers, 'notes.batch', {
      ids: [second],
      change: { kind: 'restore' },
    })
    expect((await notes.listTrash()).map((n) => n.id)).not.toContain(second)
  })

  it('empties the Trash', async () => {
    const { notes, handlers } = lists()
    const id = await notes.create('Old')
    await notes.trash(id)
    const emptied = (await run(handlers, 'trash.empty')) as { purged: number }
    expect(emptied.purged).toBeGreaterThanOrEqual(1)
    expect((await notes.listTrash()).map((n) => n.id)).not.toContain(id)
  })

  it('makes a notebook named New Notebook at the top level', async () => {
    const { books, handlers } = lists()
    const made = (await run(handlers, 'book.create')) as { id: string }
    const book = (await books.list()).find((b) => b.id === made.id)
    expect([book?.name, book?.parentId]).toStrictEqual([t('book.new'), null])
  })

  it('makes a template, and a note from one in the notebook asked for', async () => {
    const { notes, books, handlers } = lists()
    const made = (await run(handlers, 'template.create')) as { id: string }
    expect((await notes.read(made.id)).bookId).toBe(TEMPLATES_BOOK_ID)
    const book = await books.create('Work', null)
    const used = (await run(handlers, 'template.apply', {
      templateId: made.id,
      bookId: book,
    })) as {
      id: string
    }
    expect(used.id).not.toBe(made.id)
    expect((await notes.read(used.id)).bookId).toBe(book)
  })

  it("answers a note's title and Markdown for Share", async () => {
    const { notes, handlers } = lists()
    const id = await notes.create('Shared')
    await notes.setBody(id, 'Some **bold** text')
    expect(await run(handlers, 'note.text', { noteId: id })).toStrictEqual({
      title: 'Shared',
      markdown: 'Some **bold** text',
    })
  })

  it('completes a note and hands back what takes the completion away', async () => {
    const { notes, handlers } = lists()
    const id = await notes.create('Report')
    await notes.setStatus(id, 'active')
    const done = (await run(handlers, 'note.complete', { noteId: id })) as {
      undo: { status: string; updatedAt: number; statusHlc: string; bodyVersion: number }
    }
    expect((await notes.summaries([id]))[0]!.status).toBe('completed')
    expect(done.undo.status).toBe('active')
    await run(handlers, 'note.undoStatus', { noteId: id, undo: done.undo })
    const after = (await notes.summaries([id]))[0]!
    expect([after.status, after.updatedAt]).toStrictEqual(['active', done.undo.updatedAt])
  })

  it('leaves a status that was changed again after the completion', async () => {
    const { notes, handlers } = lists()
    const id = await notes.create('Report')
    const done = (await run(handlers, 'note.complete', { noteId: id })) as {
      undo: Record<string, unknown>
    }
    await notes.setStatus(id, 'on_hold')
    await run(handlers, 'note.undoStatus', { noteId: id, undo: done.undo })
    expect((await notes.summaries([id]))[0]!.status).toBe('on_hold')
  })

  it('runs an operation asked while the core is starting once it has started', async () => {
    const { notes, core } = lists()
    const gate = createCoreGate<ListsCore>()
    const id = await notes.create('Early')
    await notes.trash(id)
    const emptied = run(listHandlers(gate.started), 'trash.empty')
    gate.open(core)
    expect(((await emptied) as { purged: number }).purged).toBeGreaterThanOrEqual(1)
    expect((await notes.listTrash()).map((n) => n.id)).not.toContain(id)
  })

  it('refuses an operation once the core failed to start', async () => {
    const gate = createCoreGate<ListsCore>()
    const emptied = run(listHandlers(gate.started), 'trash.empty')
    gate.fail()
    await expect(emptied).rejects.toThrow('E_SCREENS_UNAVAILABLE')
  })
})
