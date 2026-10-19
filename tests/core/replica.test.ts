// Opening a note gives the replica the whole state once; later outside changes reach it as only what it lacks (open with its state vector).
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { BODY, createClock, createIdGenerator, createNoteService } from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

function processOn(path: string, node: string) {
  const storage = openSqliteAdapter(path)
  open.push(storage)
  return createNoteService({
    storage,
    clock: createClock(node),
    newId: createIdGenerator(),
    saveDelayMs: 5,
  })
}

describe('an editor replica', () => {
  it('takes in another process’s change as only what it lacks', async () => {
    const path = join(tempDir('devot-replica-'), 'devot.sqlite')
    const app = processOn(path, 'a1')
    const other = processOn(path, 'b1')
    const line = 'A long note, typed over many sessions, with more words than most.\n'
    const id = await app.create('Long')
    await app.setBody(id, line.repeat(16_000))
    await app.flush()

    const full = await app.open(id)
    expect(full.state.length).toBeGreaterThan(1 << 20)
    const replica = new Y.Doc()
    Y.applyUpdate(replica, full.state)

    const text = (await other.read(id)).bodyMd
    await other.setBody(id, `Changed elsewhere. ${text}`)
    await other.flush()
    await app.mergeStored()

    const known = Y.encodeStateVector(replica)
    const opened = await app.open(id, known)
    expect(opened.state.length).toBeLessThan(1024)
    Y.applyUpdate(replica, opened.state)
    expect(replica.getText(BODY).toString()).toBe(`Changed elsewhere. ${text}`)
    expect((await app.open(id, Y.encodeStateVector(replica))).state.length).toBeLessThan(16)
  })
})
