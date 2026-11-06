// How the web view reads Rust's `sync_usage` answer (relay shapes new and old), and when it lets
// a storage notice through: once per band, kept across launches.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { UsageNotice } from '../../src/core/sync/usage'
import { SYNC_OFF, type SyncSnapshot } from '../../src/renderer/src/sync'
import {
  readingFailure,
  readRelayUsage,
  resetUsageWatch,
  shownUsageNotice,
  USAGE_RECHECK_MS,
  watchUsage,
} from '../../src/renderer/src/syncUsage'
import { memoryStorage } from '../support/local-storage'

const answers: { next: unknown } = { next: undefined }
vi.mock('../../src/renderer/src/ipc', () => ({
  invoke: vi.fn<(cmd: string) => Promise<unknown>>(async (cmd) => {
    if (cmd !== 'sync_usage') throw new Error('E_UNEXPECTED')
    if (answers.next instanceof Error) throw answers.next
    return answers.next
  }),
}))

const GB = 1_000_000_000
const CAPS = { storedBytes: 4 * GB, fileBytes: 3 * GB }

it('reads each shape a relay answers in', () => {
  expect(readRelayUsage({ storedBytes: 5, fileBytes: 2, caps: CAPS })).toEqual({
    storedBytes: 5,
    fileBytes: 2,
    caps: CAPS,
  })
  expect(readRelayUsage({ storedBytes: 5, fileBytes: 2, caps: null })?.caps).toBeNull()
  expect(readRelayUsage({ storedBytes: 5, fileBytes: 2 })?.caps).toBeUndefined()
  expect(readRelayUsage({ storedBytes: 5, fileBytes: 2, caps: { storedBytes: 9 } })?.caps).toEqual({
    storedBytes: 9,
  })
})

it('refuses figures that are not figures, and a cap of nothing', () => {
  for (const value of [
    null,
    'x',
    {},
    { storedBytes: -1, fileBytes: 0 },
    { storedBytes: 1.5, fileBytes: 0 },
    { storedBytes: 1, fileBytes: 0, caps: 'big' },
    { storedBytes: 1, fileBytes: 0, caps: { storedBytes: 0 } },
    { storedBytes: 1, fileBytes: 0, caps: { storedBytes: 4, fileBytes: -1 } },
  ]) {
    expect(readRelayUsage(value)).toBeUndefined()
  }
})

it('tells an unreachable relay, a relay too old to report and any other failure apart', () => {
  expect(readingFailure('E_SYNC_OFFLINE')).toMatchObject({ why: 'offline' })
  expect(readingFailure('E_SYNC_RELAY_FAILED')).toMatchObject({ why: 'offline' })
  expect(readingFailure('E_SYNC_BAD_MESSAGE')).toMatchObject({ why: 'old' })
  expect(readingFailure('E_SYNC_REVOKED')).toMatchObject({ why: 'failed', code: 'E_SYNC_REVOKED' })
})

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
  resetUsageWatch()
})
afterEach(() => vi.unstubAllGlobals())

const snapshot = (over: Partial<SyncSnapshot['status']> = {}): SyncSnapshot => ({
  ...SYNC_OFF,
  relayUrl: 'https://relay.example.test',
  enabled: true,
  vault: true,
  enrolled: true,
  status: { ...SYNC_OFF.status, state: 'idle', ...over },
})

/** Runs a watch and returns the notice it set once the answer is in. */
async function watch(snap: SyncSnapshot, now: number): Promise<UsageNotice | null> {
  watchUsage(snap, now)
  await new Promise((done) => setTimeout(done, 0))
  return shownUsageNotice()
}

it('lets a band through once, and the same band again only after it changed', async () => {
  answers.next = { storedBytes: 3.3 * GB, fileBytes: 0, caps: CAPS }
  expect(await watch(snapshot(), 0)).toBe('storageWarn')

  // A new launch: the module forgets, the kept band does not.
  resetUsageWatch()
  expect(await watch(snapshot(), 1)).toBeNull()

  answers.next = { storedBytes: 4 * GB, fileBytes: 0, caps: CAPS }
  expect(await watch(snapshot({ state: 'paused', code: 'E_SYNC_STORAGE_FULL' }), 2)).toBe(
    'storageFull',
  )
})

it('asks again only after the recheck time unless the state changed', async () => {
  const { invoke } = await import('../../src/renderer/src/ipc')
  const calls = () => vi.mocked(invoke).mock.calls.length
  answers.next = { storedBytes: 1, fileBytes: 0, caps: CAPS }
  const before = calls()
  await watch(snapshot(), 0)
  await watch(snapshot({ lastSync: 5 }), 1000)
  expect(calls() - before).toBe(1)
  await watch(snapshot(), USAGE_RECHECK_MS + 1)
  expect(calls() - before).toBe(2)
  await watch(snapshot({ state: 'paused', code: 'E_SYNC_QUOTA' }), USAGE_RECHECK_MS + 2)
  expect(calls() - before).toBe(3)
})

it('does not ask while sync is off, not enrolled or still working', async () => {
  const { invoke } = await import('../../src/renderer/src/ipc')
  const before = vi.mocked(invoke).mock.calls.length
  await watch({ ...snapshot(), enabled: false }, 0)
  await watch({ ...snapshot(), enrolled: false }, 0)
  await watch(snapshot({ state: 'syncing' }), 0)
  expect(vi.mocked(invoke).mock.calls.length).toBe(before)
})

it('says nothing when the relay has no cap, cannot say, or cannot be reached', async () => {
  for (const next of [
    { storedBytes: 9 * GB, fileBytes: 0, caps: null },
    { storedBytes: 9 * GB, fileBytes: 0 },
    new Error('E_SYNC_OFFLINE'),
    new Error('E_SYNC_BAD_MESSAGE'),
  ]) {
    resetUsageWatch()
    answers.next = next
    expect(await watch(snapshot(), 0)).toBeNull()
  }
})

const other = (over: Partial<SyncSnapshot> = {}): SyncSnapshot => ({
  ...snapshot(),
  relayUrl: 'https://other.example.test',
  ...over,
})

it('drops an answer still on its way when the device leaves that relay', async () => {
  answers.next = { storedBytes: 3.3 * GB, fileBytes: 0, caps: CAPS }
  watchUsage(snapshot(), 0)
  expect(await watch(other({ enrolled: false }), 1)).toBeNull()
})

it('drops an answer still on its way when the next relay has not settled', async () => {
  answers.next = { storedBytes: 3.3 * GB, fileBytes: 0, caps: CAPS }
  watchUsage(snapshot(), 0)
  const busy = other({ status: { ...SYNC_OFF.status, state: 'syncing' } })
  expect(await watch(busy, 1)).toBeNull()
})

it('keeps the bands told for each relay apart', async () => {
  answers.next = { storedBytes: 3.3 * GB, fileBytes: 0, caps: CAPS }
  expect(await watch(snapshot(), 0)).toBe('storageWarn')
  expect(await watch(other(), 1)).toBe('storageWarn')

  resetUsageWatch()
  expect(await watch(snapshot(), 2)).toBeNull()
})
