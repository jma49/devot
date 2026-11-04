import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { catchUp } from './catchUp'

const BODY = 'body'

/** A core's document and what it answers `open(id, known)` with. */
function coreDoc(text: string) {
  const doc = new Y.Doc()
  doc.getText(BODY).insert(0, text)
  const open = (known: Uint8Array) => Promise.resolve({ state: Y.encodeStateAsUpdate(doc, known) })
  return { doc, open }
}

const replicaOf = (state: Uint8Array) => {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  return doc
}

describe('catchUp', () => {
  it('takes the changes the core made after the state the replica was made from, so later increments apply', async () => {
    const core = coreDoc('Start.')
    const replica = replicaOf(Y.encodeStateAsUpdate(core.doc))
    // Increments sent while nobody took them: the replica never saw these.
    core.doc.getText(BODY).insert(6, ' One')
    let next: Uint8Array | undefined
    core.doc.once('update', (update: Uint8Array) => (next = update))
    core.doc.getText(BODY).insert(10, ' Two')
    Y.applyUpdate(replica, next!)
    expect(replica.getText(BODY).toString()).toBe('Start.')

    const origins: unknown[] = []
    replica.on('update', (_u: Uint8Array, origin: unknown) => origins.push(origin))
    await catchUp(replica, core.open, () => true, 'remote')
    expect(replica.getText(BODY).toString()).toBe('Start. One Two')
    expect(origins).toEqual(['remote'])
  })

  it('leaves a replica no longer shown alone', async () => {
    const core = coreDoc('Start.')
    const replica = replicaOf(Y.encodeStateAsUpdate(core.doc))
    core.doc.getText(BODY).insert(6, ' One')
    await catchUp(replica, core.open, () => false, 'remote')
    expect(replica.getText(BODY).toString()).toBe('Start.')
  })

  it('asks only for what the replica lacks, typing made in it meanwhile included', async () => {
    const core = coreDoc('Start.')
    const replica = replicaOf(Y.encodeStateAsUpdate(core.doc))
    replica.getText(BODY).insert(0, 'Here: ')
    core.doc.getText(BODY).insert(6, ' One')
    const known = Y.encodeStateVector(replica)
    const open = vi.fn<typeof core.open>(core.open)
    await catchUp(replica, open, () => true, 'remote')
    expect(open).toHaveBeenCalledWith(known)
    expect(replica.getText(BODY).toString()).toBe('Here: Start. One')
  })

  it('logs a refused catch-up with its code and keeps the replica as it was', async () => {
    const replica = replicaOf(Y.encodeStateAsUpdate(coreDoc('Start.').doc))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await catchUp(
      replica,
      () => Promise.reject(new Error('E_NOTE_NOT_FOUND')),
      () => true,
      'remote',
    )
    expect(warn).toHaveBeenCalledWith('W_NOTE_CATCH_UP_FAILED', 'E_NOTE_NOT_FOUND')
    expect(replica.getText(BODY).toString()).toBe('Start.')
    warn.mockRestore()
  })
})
