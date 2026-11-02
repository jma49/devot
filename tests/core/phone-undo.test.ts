import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  type NoteService,
} from '../../src/core'
import type { NoteStatus } from '../../src/core/storage'
import { completeNote, trashNote, undoNote, type UndoCore } from '../../src/renderer/src/phone/undo'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

function setup() {
  const storage = openSqliteAdapter(join(tempDir('devot-phone-undo-'), 'devot.sqlite'))
  open.push(storage)
  const clock = createClock('phone')
  const newId = createIdGenerator()
  const books = createBookService({ storage, clock, newId })
  const notes = createNoteService({ storage, clock, newId, saveDelayMs: 5 })
  const tags = createTagService({ storage, clock, newId })
  const core: UndoCore = {
    setStatusUndoable: notes.setStatusUndoable,
    undoStatus: notes.undoStatus,
    trash: notes.trash,
    restore: notes.restore,
  }
  return { storage, clock, newId, books, notes, tags, core }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

// `bodyVersion` is storage's compare-and-set counter: every write moves it on, and it must not go back.
const summary = async (notes: NoteService, id: string) => {
  await notes.flush()
  const found = (await notes.list()).find((n) => n.id === id)
  if (!found) throw new Error('E_TEST_NOTE_NOT_LISTED')
  const { bodyVersion: _bodyVersion, ...state } = found
  return state
}

const asSummary = async (notes: NoteService, id: string) =>
  (await notes.list()).find((n) => n.id === id)!

async function seeded(status: NoteStatus, pinned: boolean) {
  const ctx = setup()
  const book = await ctx.books.create('Work', null)
  const id = await ctx.notes.create('Relay retention', book)
  await ctx.notes.setBody(id, 'Keep thirty days.')
  await ctx.tags.addToNote(id, 'infra')
  await ctx.notes.setStatus(id, status)
  if (pinned) await ctx.notes.setPinned(id, true)
  await ctx.notes.flush()
  // A later save must be able to show up as a later time.
  await tick()
  return {
    ...ctx,
    id,
    book,
    note: await asSummary(ctx.notes, id),
    before: await summary(ctx.notes, id),
  }
}

describe('undoing a trash', () => {
  it.each([
    ['active', false],
    ['on_hold', true],
    ['none', false],
  ] as const)('restores a %s note, pinned %s, exactly', async (status, pinned) => {
    const { notes, core, storage, id, note, before } = await seeded(status, pinned)
    expect(before.tagIds).toHaveLength(1)
    const undo = trashNote(core, note)
    await undo.done
    expect((await notes.list()).map((n) => n.id)).not.toContain(id)
    await undoNote(core, undo)
    expect(await summary(notes, id)).toEqual(before)
    expect((await storage.getNote(id))!.bodyMd).toBe('Keep thirty days.')
    expect((await notes.listTrash()).map((n) => n.id)).not.toContain(id)
  })

  it('works when undone before the trash has finished', async () => {
    const { notes, core, id, note, before } = await seeded('active', false)
    await undoNote(core, trashNote(core, note))
    expect(await summary(notes, id)).toEqual(before)
  })
})

describe('undoing a complete', () => {
  it.each([
    ['active', false],
    ['on_hold', true],
    ['dropped', false],
    ['none', false],
  ] as const)('restores a %s note, pinned %s, and its time', async (status, pinned) => {
    const { notes, core, storage, id, note, before } = await seeded(status, pinned)
    const undo = completeNote(core, note)
    await undo!.done
    const completed = await summary(notes, id)
    expect(completed.status).toBe('completed')
    expect(completed.updatedAt).toBeGreaterThan(before.updatedAt)
    await tick()
    await undoNote(core, undo!)
    expect(await summary(notes, id)).toEqual(before)
    expect((await storage.getNote(id))!.bodyMd).toBe('Keep thirty days.')
  })

  it('keeps the order of the list', async () => {
    const { notes, core, id: older, note, before } = await seeded('active', false)
    const newer = await notes.create('Newer', null)
    await notes.flush()
    await tick()
    const undo = completeNote(core, note)
    await undo!.done
    await notes.flush()
    await tick()
    await undoNote(core, undo!)
    await notes.flush()
    const list = await notes.list()
    const times = new Map(list.map((n) => [n.id, n.updatedAt]))
    expect(times.get(newer)!).toBeGreaterThan(times.get(older)!)
    expect(times.get(older)).toBe(before.updatedAt)
  })

  it('works when undone before the write', async () => {
    const { notes, core, id, note, before } = await seeded('active', false)
    await undoNote(core, completeNote(core, note)!)
    expect(await summary(notes, id)).toEqual(before)
  })

  it('does nothing to a note already completed', async () => {
    const { notes, core, id, note, before } = await seeded('completed', false)
    expect(completeNote(core, note)).toBeNull()
    expect(await summary(notes, id)).toEqual(before)
  })
})

describe('undoing a complete after something newer', () => {
  const completed = async (status: NoteStatus = 'active') => {
    const ctx = await seeded(status, false)
    const undo = completeNote(ctx.core, ctx.note)!
    await undo.done
    await tick()
    return { ...ctx, undo, afterAction: await summary(ctx.notes, ctx.id) }
  }

  it('restores the status but keeps the time of a saved edit', async () => {
    const { notes, core, storage, id, undo, before } = await completed()
    await notes.setBody(id, 'Keep sixty days.')
    await notes.flush()
    const edited = await summary(notes, id)
    await tick()
    await undoNote(core, undo)
    const after = await summary(notes, id)
    expect(after.status).toBe(before.status)
    expect(after.updatedAt).toBeGreaterThanOrEqual(edited.updatedAt)
    expect((await storage.getNote(id))!.bodyMd).toBe('Keep sixty days.')
  })

  it('counts an edit still waiting to be saved', async () => {
    const { notes, core, storage, id, undo, before, afterAction } = await completed()
    await notes.setBody(id, 'Keep sixty days.')
    await undoNote(core, undo)
    const after = await summary(notes, id)
    expect(after.status).toBe(before.status)
    expect(after.updatedAt).toBeGreaterThanOrEqual(afterAction.updatedAt)
    expect((await storage.getNote(id))!.bodyMd).toBe('Keep sixty days.')
  })

  it('counts any other write of the note', async () => {
    const { notes, core, id, undo, before, afterAction } = await completed()
    await notes.setPinned(id, true)
    await notes.flush()
    await undoNote(core, undo)
    const after = await summary(notes, id)
    expect(after).toMatchObject({ status: before.status, pinned: true })
    expect(after.updatedAt).toBeGreaterThanOrEqual(afterAction.updatedAt)
  })

  it('leaves a newer status set here, and its time', async () => {
    const { notes, core, id, undo } = await completed()
    await notes.setStatus(id, 'dropped')
    await notes.flush()
    const newer = await summary(notes, id)
    await tick()
    await undoNote(core, undo)
    expect(await summary(notes, id)).toEqual(newer)
  })

  it('leaves a newer status that arrived in storage while the note is in memory', async () => {
    const { storage, newId, notes, core, id, undo } = await completed()
    const device = createNoteService({
      storage,
      clock: createClock('mac'),
      newId,
    })
    await device.setStatus(id, 'on_hold')
    await device.release(id)
    const arrived = await storage.getNote(id)
    await tick()
    await undoNote(core, undo)
    expect(await summary(notes, id)).toMatchObject({
      status: 'on_hold',
      updatedAt: arrived!.updatedAt,
    })
    expect((await storage.getNote(id))!.statusHlc).toBe(arrived!.statusHlc)
  })

  it('does not undo an edit made before the complete, along with it', async () => {
    const { notes, core, id, note, before } = await seeded('active', false)
    await notes.setBody(id, 'Keep sixty days.')
    const undo = completeNote(core, note)!
    await undo.done
    const saved = (await summary(notes, id)).updatedAt
    await tick()
    await undoNote(core, undo)
    const after = await summary(notes, id)
    expect(after.status).toBe(before.status)
    expect(after.updatedAt).toBeLessThanOrEqual(saved)
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt)
  })
})
