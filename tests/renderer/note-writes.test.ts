import { describe, expect, it } from 'vitest'
import { createClock, createIdGenerator, createNoteService, newWriter } from '../../src/core'
import { reportingNoteWrites } from '../../src/renderer/src/noteWrites'
import { fromWire, toWire } from '../../src/renderer/src/storage/wire'
import { tempSqliteAdapter } from '../support/sqlite-adapter'

const storage = () => tempSqliteAdapter('devot-writes-')

const reported = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('reportingNoteWrites', () => {
  it('reports each completed note write with its new date', async () => {
    const heard: Map<string, number>[] = []
    let clock = 1_000
    const adapter = storage()
    const notes = createNoteService({
      // As the window serves storage to the core worker (see core-client.ts).
      storage: fromWire(
        reportingNoteWrites(toWire(adapter), (writes) => heard.push(new Map(writes))),
      ),
      clock: createClock('mac1'),
      newId: createIdGenerator(),
      now: () => clock,
      saveDelayMs: 5,
    })
    const a = await notes.create('A')
    const b = await notes.create('B')
    await reported()
    expect(heard).toEqual([new Map([[a, 1_000]]), new Map([[b, 1_000]])])

    clock = 2_000
    await notes.setBody(a, 'typed')
    await notes.flush()
    await reported()
    expect(heard.at(-1)).toEqual(new Map([[a, 2_000]]))
    expect((await adapter.getNote(a))?.updatedAt).toBe(2_000)
  })

  it('reports nothing for a write that failed', async () => {
    const heard: Map<string, number>[] = []
    const adapter = storage()
    const wrapped = fromWire(
      reportingNoteWrites(toWire(adapter), (writes) => heard.push(new Map(writes))),
    )
    const notes = createNoteService({
      storage: wrapped,
      clock: createClock('mac1'),
      newId: createIdGenerator(),
      saveDelayMs: 5,
    })
    const id = await notes.create('A')
    await reported()
    heard.length = 0
    const record = await adapter.getNote(id)
    adapter.close()
    await expect(wrapped.putNote({ ...record!, updatedAt: 9_000 })).rejects.toThrow('not open')
    await reported()
    expect(heard).toEqual([])
  })

  it('tells of writes that change agent_writes rows, never of the owner’s own saves', async () => {
    let authored = 0
    const adapter = storage()
    const notes = createNoteService({
      storage: fromWire(
        reportingNoteWrites(
          toWire(adapter),
          () => {},
          () => (authored += 1),
        ),
      ),
      clock: createClock('mac1'),
      newId: createIdGenerator(),
      saveDelayMs: 5,
    })
    const id = await notes.create('A')
    await reported()
    authored = 0
    await notes.setBody(id, 'typed')
    await notes.flush()
    await notes.setBody(id, 'typed more')
    await notes.flush()
    await reported()
    expect(authored).toBe(0)

    await notes.agentWrite(id, {
      writer: newWriter('mcp', 'Claude Code', 'mcp00aa11bb22cc'),
      markdown: 'Agent text.\n',
    })
    await notes.flush()
    await reported()
    expect(authored).toBe(1)
    expect(await adapter.authoredNotes()).toEqual([id])

    await notes.setBody(id, 'typed more\nAgent text.\nOwner text.\n')
    await notes.flush()
    await reported()
    expect(authored).toBe(1)
  })
})
