// What a relay says it holds and may hold, and when that is worth a notice (docs/sync-relay.md,
// Quota). The figures are the relay's own `usage` message, in its three shapes: with caps, with
// caps null (RELAY_QUOTA=off) and without caps (a relay older than the cap).
import { expect, it } from 'vitest'
import {
  NOTHING_SEEN,
  noticeFor,
  viewStorage,
  type RelayStorage,
  type Seen,
} from '../../src/core/sync/usage'

const GB = 1_000_000_000
const CAPS = { storedBytes: 4 * GB, fileBytes: 3 * GB }
const usage = (storedBytes: number, fileBytes: number, caps: RelayStorage['caps']) => ({
  storedBytes,
  fileBytes,
  caps,
})

it('splits the stored bytes into images and everything else, and says the room left', () => {
  expect(viewStorage(usage(1.5 * GB, 1 * GB, CAPS))).toMatchObject({
    cap: 'set',
    recordBytes: 0.5 * GB,
    fileBytes: 1 * GB,
    storedBytes: 1.5 * GB,
    limit: 4 * GB,
    imageLimit: 3 * GB,
    room: 2.5 * GB,
    imageRoom: 2 * GB,
    storage: 'ok',
    images: 'ok',
  })
})

it('never offers images more room than is left in total', () => {
  const view = viewStorage(usage(3.9 * GB, 1 * GB, CAPS))
  expect(view).toMatchObject({ room: 0.1 * GB, imageRoom: 0.1 * GB })
})

it('keeps the notes’ room even when images have used their whole share', () => {
  const view = viewStorage(usage(3 * GB + 1e6, 3 * GB, CAPS))
  expect(view).toMatchObject({ images: 'full', storage: 'ok', imageRoom: 0 })
  expect(view.cap === 'set' && view.room).toBeGreaterThan(0.9 * GB)
})

it('moves to a warning at 80% of a cap and to full at the cap', () => {
  const at = (stored: number, files: number) => {
    const view = viewStorage(usage(stored, files, CAPS))
    return view.cap === 'set' ? [view.storage, view.images] : []
  }
  expect(at(3.19 * GB, 0)).toEqual(['ok', 'ok'])
  expect(at(3.2 * GB, 0)).toEqual(['warn', 'ok'])
  expect(at(4 * GB, 0)).toEqual(['full', 'ok'])
  expect(at(2.4 * GB, 2.4 * GB)).toEqual(['ok', 'warn'])
  expect(at(3.2 * GB, 3 * GB)).toEqual(['warn', 'full'])
})

it('reports a relay without a cap, and one too old to say, without inventing a limit', () => {
  expect(viewStorage(usage(9 * GB, 1, null))).toEqual({
    cap: 'none',
    storedBytes: 9 * GB,
    fileBytes: 1,
    recordBytes: 9 * GB - 1,
  })
  expect(viewStorage(usage(5, 2, undefined))).toEqual({
    cap: 'unknown',
    storedBytes: 5,
    fileBytes: 2,
    recordBytes: 3,
  })
})

it('reads a relay from before the attachment share: a cap for the total, none for images', () => {
  const view = viewStorage(usage(GB, 0, { storedBytes: 4 * GB }))
  expect(view).toMatchObject({ cap: 'set', imageLimit: null, imageRoom: null, images: 'ok' })
})

it('does not let a stored total below the images’ bytes go negative', () => {
  expect(viewStorage(usage(1, 5, CAPS))).toMatchObject({ recordBytes: 0 })
})

const view = (stored: number, files: number) => viewStorage(usage(stored, files, CAPS))

it('tells a band once, then stays quiet while the band stays', () => {
  const first = noticeFor(view(3.3 * GB, 0), NOTHING_SEEN)
  expect(first.notice).toBe('storageWarn')
  expect(first.seen).toEqual({ storage: 'warn', images: 'ok' })
  expect(noticeFor(view(3.5 * GB, 0), first.seen).notice).toBeNull()
})

it('tells the next band when it comes', () => {
  const seen: Seen = { storage: 'warn', images: 'ok' }
  expect(noticeFor(view(4 * GB, 0), seen).notice).toBe('storageFull')
})

it('says nothing about a drop, and tells the band again when it returns', () => {
  const down = noticeFor(view(1 * GB, 0), { storage: 'full', images: 'ok' })
  expect(down).toEqual({ notice: null, seen: NOTHING_SEEN })
  expect(noticeFor(view(3.3 * GB, 0), down.seen).notice).toBe('storageWarn')
})

it('names images when only their share has filled, and the storage first when both have', () => {
  expect(noticeFor(view(3 * GB, 3 * GB), { storage: 'warn', images: 'ok' }).notice).toBe(
    'imagesFull',
  )
  expect(noticeFor(view(2.5 * GB, 2.5 * GB), NOTHING_SEEN).notice).toBe('imagesWarn')
  expect(noticeFor(view(4 * GB, 3 * GB), NOTHING_SEEN).notice).toBe('storageFull')
})

it('forgets what it told when the relay has no cap or cannot say', () => {
  const seen: Seen = { storage: 'full', images: 'full' }
  expect(noticeFor(viewStorage(usage(1, 0, null)), seen)).toEqual({
    notice: null,
    seen: NOTHING_SEEN,
  })
  expect(noticeFor(viewStorage(usage(1, 0, undefined)), seen).notice).toBeNull()
})
