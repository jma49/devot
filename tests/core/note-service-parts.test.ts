import { describe, expect, it } from 'vitest'
import { createClock } from '../../src/core/hlc'
import { createIdGenerator } from '../../src/core/ids'
import * as notes from '../../src/core/notes'
import { createContext } from '../../src/core/notes/context'
import { creatingMethods } from '../../src/core/notes/creating'
import { createKernel } from '../../src/core/notes/kernel'
import { tempSqliteAdapter } from '../support/sqlite-adapter'

function parts(now?: () => number) {
  const ctx = createContext({
    storage: tempSqliteAdapter('devot-note-parts-'),
    clock: createClock('mac1'),
    newId: createIdGenerator(),
    ...(now ? { now } : {}),
  })
  return { ctx, k: createKernel(ctx) }
}

describe('note service parts', () => {
  it('keeps the module exporting what it exported before the split', () => {
    expect(Object.keys(notes).sort()).toEqual([
      'BODY',
      'NOTES_IN_MEMORY',
      'bodyText',
      'createNoteService',
      'saveDelay',
      'seedClient',
    ])
  })

  it('times the service by the given clock, or by Date.now', () => {
    expect(parts(() => 42).ctx.now()).toBe(42)
    expect(parts().ctx.now).toBe(Date.now)
  })

  it('shares one context between the parts', async () => {
    const { ctx, k } = parts()
    expect(ctx.live.size).toBe(0)
    const id = await creatingMethods(ctx, k).create('Plan')
    expect(ctx.live.get(id)?.record.title).toBe('Plan')
    const read = await k.memory.using(id, (note) => note)
    expect(read).toBe(ctx.live.get(id))
  })

  it('settles once the versions asked for are written', async () => {
    const { ctx, k } = parts()
    const id = await creatingMethods(ctx, k).create()
    const note = ctx.live.get(id)!
    k.versions.editBody(note, () => note.doc.getText(notes.BODY).insert(0, 'hello'))
    k.versions.takeVersion(note)
    await k.versions.settled()
    const kept = await ctx.storage.listRevisions(id)
    expect(kept.filter((r) => r.kind === 'body')).toHaveLength(1)
    k.memory.drop(note)
  })

  it('holds compaction sweeps until resumed', async () => {
    const { ctx, k } = parts()
    let sweeps = 0
    const lastCompaction = ctx.storage.lastCompaction.bind(ctx.storage)
    ctx.storage.lastCompaction = () => {
      sweeps += 1
      return lastCompaction()
    }
    await k.versions.holdCompaction()
    k.versions.sweep()
    await k.versions.holdCompaction()
    expect(sweeps).toBe(0)
    k.versions.resumeCompaction()
    k.versions.sweep()
    await k.versions.holdCompaction()
    expect(sweeps).toBe(1)
  })
})
