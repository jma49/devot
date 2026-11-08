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
import { memoryStorage } from '../../storage/memory'
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
    applyTemplate: (id, now, bookId) => templates.apply(id, { now }, bookId),
    read: (id) => notes.read(id),
  }
  return {
    notes,
    books,
    tags,
    handlers: listHandlers(
      () => core,
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

  it('refuses an operation before the core has started', async () => {
    const handlers = listHandlers(() => null)
    await expect(run(handlers, 'trash.empty')).rejects.toThrow('E_SCREENS_UNAVAILABLE')
  })
})
