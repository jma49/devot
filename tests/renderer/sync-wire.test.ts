// The engine's transport as it crosses to the page: iCloud takes a batch in one command, the relay
// one push at a time.
import { expect, it, vi } from 'vitest'
import type { PushResult, Welcome } from '../../src/core/sync/transport'
import {
  fromWireTransport,
  type WirePushItem,
  type WireTransport,
} from '../../src/renderer/src/storage/syncWire'
import { toBase64 } from '../../src/renderer/src/storage/wire'

const item = (id: string, byte: number) => ({
  id,
  base: 0,
  tag: '',
  plaintext: new Uint8Array([byte]),
  kind: 'record' as const,
})

function wire() {
  return {
    connect: vi.fn<WireTransport['connect']>(async () => ({}) as Welcome),
    pull: vi.fn<WireTransport['pull']>(async () => ({ records: [], next: '', more: false })),
    push: vi.fn<WireTransport['push']>(async () => ({ type: 'pushed', version: 1, tag: '' })),
    pushMany: vi.fn<(items: WirePushItem[]) => Promise<PushResult[]>>(async (items) =>
      items.map(() => ({ type: 'pushed', version: 1, tag: 't' })),
    ),
    close: vi.fn<WireTransport['close']>(async () => {}),
  } satisfies WireTransport
}

it('sends a batch on iCloud in one call, its plaintext as base64', async () => {
  const w = wire()
  const results = await fromWireTransport(w, 'icloud').pushMany([item('a', 1), item('b', 2)])
  expect(w.pushMany).toHaveBeenCalledOnce()
  expect(w.pushMany.mock.calls[0]?.[0]).toEqual([
    { id: 'a', base: 0, data: toBase64(new Uint8Array([1])), kind: 'record', tag: '' },
    { id: 'b', base: 0, data: toBase64(new Uint8Array([2])), kind: 'record', tag: '' },
  ])
  expect(w.push).not.toHaveBeenCalled()
  expect(results).toHaveLength(2)
})

it('sends a batch to the relay one push at a time', async () => {
  const w = wire()
  await fromWireTransport(w).pushMany([item('a', 1), item('b', 2)])
  expect(w.push).toHaveBeenCalledTimes(2)
  expect(w.pushMany).not.toHaveBeenCalled()
})
