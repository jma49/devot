// The cost of a save of a big note: on the UI thread, which must not do work for each byte of the
// note, and in the worker for a save that changed no text.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { sampleNote } from '../../scripts/bench/fixtures'
import { createNoteService } from '../../src/core'
import { createClock } from '../../src/core/hlc'
import { createIdGenerator } from '../../src/core/ids'
import { invoke } from '../../src/renderer/src/ipc'
import { tauriWire } from '../../src/renderer/src/storage/tauri'
import { fromWire, toWire, type WireStorage } from '../../src/renderer/src/storage/wire'
import { expectWithinBudget } from '../support/budget'
import { tempSqliteAdapter } from '../support/sqlite-adapter'
import { crossed, tauriIpcBody } from '../support/tauri-ipc'

vi.mock('../../src/renderer/src/ipc', () => ({
  invoke: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
}))

const MIB = 1 << 20
let pageMs = 0
beforeEach(() => {
  pageMs = 0
  vi.mocked(invoke).mockImplementation(async (_cmd, args) => {
    tauriIpcBody(args)
    return null
  })
})
afterEach(() => vi.mocked(invoke).mockReset())

/** The page's storage as the worker reaches it, timing what the page does with each note write. */
function timedPage(page: WireStorage): WireStorage {
  const timed =
    <A extends unknown[]>(call: (...args: A) => Promise<void>) =>
    async (...args: A) => {
      const start = performance.now()
      const done = call(...(args.map(crossed) as A))
      pageMs += performance.now() - start
      await done
    }
  return {
    ...page,
    putNote: timed((note) => page.putNote(note)),
    putNoteMeta: timed((note) => page.putNoteMeta(note)),
  }
}

async function bigNote(bytes: number, pageOf: (stored: WireStorage) => WireStorage) {
  const sqlite = tempSqliteAdapter('devot-save-path-')
  const stored = toWire(sqlite)
  const watched: WireStorage = { ...stored, ...timedPage(pageOf(stored)) }
  const notes = createNoteService({
    storage: fromWire(watched),
    clock: createClock('mac1'),
    newId: createIdGenerator(),
  })
  const id = await notes.create('Big')
  await notes.setBody(id, sampleNote(bytes))
  return { notes, id, sqlite }
}

it('costs the UI thread no work for each byte of a 5 MiB note’s save', async (context) => {
  const { notes } = await bigNote(5 * MIB, () => tauriWire)
  pageMs = 0
  await notes.flush()
  expect(vi.mocked(invoke).mock.calls.map(([cmd]) => cmd)).toContain('note_put')
  // About 15 ms in Node when the note crossed as JSON with its state in base64.
  expectWithinBudget(context, pageMs, 2)
}, 60_000)

it('saves a title of a 5 MiB note with no work for each byte of it outside storage', async (context) => {
  const written: string[] = []
  const { notes, id } = await bigNote(5 * MIB, (stored) => ({
    ...stored,
    // Storage itself rewrites the note's row whatever changed; what is timed here is the rest.
    putNote: async () => void written.push('note'),
    putNoteMeta: async () => void written.push('meta'),
  }))
  await notes.flush()
  await notes.setTitle(id, 'Renamed')
  const start = performance.now()
  await notes.flush()
  expect(written.at(-1)).toBe('meta')
  // About 25 ms in Node when the whole note was coded and crossed again.
  expectWithinBudget(context, performance.now() - start, 3)
}, 60_000)
