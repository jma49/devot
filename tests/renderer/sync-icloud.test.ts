// Each iCloud state Settings > Sync and the notice show, read from the snapshot as Rust sends it.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { setIPhoneWording } from '../../src/renderer/src/i18n'
import { WHY } from '../../src/renderer/src/settings/syncWhy'
import { readSnapshot, type SyncSnapshot } from '../../src/renderer/src/sync'
import {
  icloudAttention,
  icloudLine,
  icloudNotice,
  readICloudStatus,
  syncNeedsOwner,
  type ICloudStatus,
} from '../../src/renderer/src/syncICloud'
import { syncNoticeMessages } from '../../src/renderer/src/syncNoticeText'

const ICLOUD: ICloudStatus = { available: true, account: 'available' }
const later = Date.now() + 3_600_000

/** A snapshot shaped as Rust's `Snapshot` serializes. */
export function rust(over: {
  enabled?: boolean
  transport?: 'relay' | 'icloud'
  vault?: boolean
  enrolled?: boolean
  status?: Record<string, unknown>
  icloudJoin?: Record<string, unknown> | null
  moveStarted?: boolean
}): SyncSnapshot {
  const snapshot = readSnapshot({
    relayUrl: over.transport === 'relay' ? 'https://relay.example.test' : '',
    enabled: over.enabled ?? true,
    transport: over.transport ?? 'icloud',
    vault: over.vault ?? true,
    enrolled: over.enrolled ?? false,
    status: { state: 'idle', lastSync: null, code: null, tooLarge: 0, ...over.status },
    icloudJoin: over.icloudJoin ?? null,
    moveStarted: over.moveStarted ?? false,
  })
  if (!snapshot) throw new Error('unread')
  return snapshot
}

const stopped = (code: string) => rust({ status: { state: 'stopped', code } })
const paused = (code: string, pausedUntil: number | null = null) =>
  rust({ status: { state: 'paused', code, pausedUntil } })

describe('the iCloud states', () => {
  it('reads what the account and the engine report', () => {
    expect(icloudAttention(paused('E_SYNC_ICLOUD_SIGNED_OUT'))).toEqual({ kind: 'signedOut' })
    expect(icloudAttention(paused('E_SYNC_ICLOUD_RESTRICTED'))).toEqual({ kind: 'restricted' })
    expect(icloudAttention(paused('E_SYNC_ICLOUD_FULL'))).toEqual({ kind: 'full' })
    expect(
      icloudAttention(
        rust({ status: { state: 'offline', code: 'E_SYNC_ICLOUD_ACCOUNT_UNAVAILABLE' } }),
      ),
    ).toEqual({ kind: 'unavailable' })
    expect(icloudAttention(paused('E_SYNC_ICLOUD_BUSY', later))).toEqual({
      kind: 'busy',
      until: later,
    })
    expect(icloudAttention(stopped('E_SYNC_ICLOUD_ACCOUNT_CHANGED'))).toEqual({
      kind: 'accountChanged',
    })
    expect(icloudAttention(stopped('E_SYNC_ICLOUD_DELETED'))).toEqual({ kind: 'deleted' })
    expect(icloudAttention(stopped('E_SYNC_CLOUDKIT_UNAVAILABLE'))).toEqual({
      kind: 'noContainer',
    })
  })

  it('reads the look for the Apple ID’s vault on a device that holds none', () => {
    const look = (icloudJoin: Record<string, unknown>) =>
      icloudAttention(rust({ enabled: false, vault: false, transport: 'relay', icloudJoin }))
    expect(look({ state: 'ask', notes: 12 })).toEqual({ kind: 'ask', notes: 12 })
    expect(look({ state: 'fallback', reason: 'missing' })).toEqual({
      kind: 'fallback',
      reason: 'missing',
    })
    expect(look({ state: 'fallback', reason: 'otherVault' })).toEqual({
      kind: 'fallback',
      reason: 'otherVault',
    })
    expect(look({ state: 'unavailable', code: 'E_SYNC_ICLOUD_SIGNED_OUT' })).toEqual({
      kind: 'signedOut',
    })
    expect(look({ state: 'none' })).toBeUndefined()
    expect(look({ state: 'declined' })).toBeUndefined()
    expect(icloudAttention(rust({ icloudJoin: { state: 'joined' } }))).toEqual({ kind: 'joined' })
  })

  it('reads a vault moved off a relay', () => {
    const moved = rust({
      transport: 'relay',
      enrolled: true,
      status: { state: 'stopped', code: 'E_SYNC_VAULT_MOVED' },
    })
    expect(icloudAttention(moved)).toEqual({ kind: 'moved' })
    expect(icloudLine({ kind: 'moved' }, moved, ICLOUD, false).actions).toEqual(['follow'])
    // A build without the container cannot follow; it says to set sync up again.
    expect(
      icloudLine({ kind: 'moved' }, moved, { available: false, account: null }, false).actions,
    ).toEqual([])
  })

  it('says a move to iCloud this device started and did not finish began here', () => {
    const unfinished = rust({
      transport: 'relay',
      enrolled: true,
      moveStarted: true,
      status: { state: 'stopped', code: 'E_SYNC_VAULT_MOVED' },
    })
    const attention = icloudAttention(unfinished)
    expect(attention).toEqual({ kind: 'movedHere' })
    if (!attention) throw new Error('no attention')
    const line = icloudLine(attention, unfinished, ICLOUD, false)
    expect(line.text).toMatch(/started on this device/)
    expect(line.text).not.toMatch(/another of your devices/)
    expect(line.actions).toEqual(['finish'])
    expect(icloudNotice(attention, false)).toMatch(/started on this device/)
    expect(syncNeedsOwner(unfinished)).toBe(true)
    // A started move counts only while sync stops on the marker.
    expect(icloudAttention(rust({ transport: 'relay', moveStarted: true }))).toBeUndefined()
  })

  it('leaves a relay vault and a healthy iCloud vault alone', () => {
    expect(icloudAttention(rust({ transport: 'relay', enrolled: true }))).toBeUndefined()
    expect(icloudAttention(rust({}))).toBeUndefined()
    expect(
      icloudAttention(
        rust({
          transport: 'relay',
          status: { state: 'paused', code: 'E_SYNC_QUOTA', pausedUntil: later },
        }),
      ),
    ).toBeUndefined()
  })

  it('offers what to do: move or turn off, upload again or turn off, join or not', () => {
    const actions = (snapshot: SyncSnapshot) =>
      icloudLine(icloudAttention(snapshot)!, snapshot, ICLOUD, false).actions
    expect(actions(stopped('E_SYNC_ICLOUD_ACCOUNT_CHANGED'))).toEqual(['moveHere', 'turnOff'])
    expect(actions(stopped('E_SYNC_ICLOUD_DELETED'))).toEqual(['uploadAgain', 'turnOff'])
    expect(actions(stopped('E_SYNC_CLOUDKIT_UNAVAILABLE'))).toEqual(['turnOff'])
    expect(
      actions(rust({ enabled: false, vault: false, icloudJoin: { state: 'ask', notes: 3 } })),
    ).toEqual(['join', 'decline'])
    for (const code of [
      'E_SYNC_ICLOUD_SIGNED_OUT',
      'E_SYNC_ICLOUD_RESTRICTED',
      'E_SYNC_ICLOUD_FULL',
    ])
      expect(actions(paused(code))).toEqual([])
  })

  it('words each state, with the time of a timed pause and the count of a join', () => {
    const line = (snapshot: SyncSnapshot) =>
      icloudLine(icloudAttention(snapshot)!, snapshot, ICLOUD, false).text
    expect(line(paused('E_SYNC_ICLOUD_SIGNED_OUT'))).toMatch(/Sign in to iCloud/)
    expect(line(paused('E_SYNC_ICLOUD_RESTRICTED'))).toMatch(/restricted/)
    expect(line(paused('E_SYNC_ICLOUD_FULL'))).toMatch(/iCloud storage is full/)
    expect(line(paused('E_SYNC_ICLOUD_BUSY', later))).toMatch(/^Sync paused until .+: iCloud/)
    expect(line(paused('E_SYNC_ICLOUD_BUSY', null))).toMatch(/resumes in a moment/)
    expect(line(stopped('E_SYNC_ICLOUD_ACCOUNT_CHANGED'))).toMatch(/another Apple ID/)
    expect(line(stopped('E_SYNC_ICLOUD_DELETED'))).toMatch(/removed from iCloud/)
    expect(
      line(rust({ enabled: false, vault: false, icloudJoin: { state: 'ask', notes: 1200 } })),
    ).toMatch(/1,200 notes/)
    expect(
      line(
        rust({
          enabled: false,
          vault: false,
          icloudJoin: { state: 'fallback', reason: 'missing' },
        }),
      ),
    ).toMatch(/pairing code .+ recovery key/)
    expect(line(rust({ icloudJoin: { state: 'joined' } }))).toMatch(/iCloud Keychain and joined/)
  })

  it('says the device joined only while sync runs well, never over a later state', () => {
    const joined = (status: Record<string, unknown>) =>
      rust({ icloudJoin: { state: 'joined' }, status })
    for (const state of ['idle', 'syncing', 'connecting'])
      expect(icloudAttention(joined({ state }))).toEqual({ kind: 'joined' })
    expect(icloudAttention(joined({ state: 'offline' }))).toBeUndefined()
    expect(
      icloudAttention(joined({ state: 'stopped', code: 'E_LICENCE_REQUIRED' })),
    ).toBeUndefined()
    expect(icloudAttention(joined({ state: 'syncing', code: 'E_SYNC_OFFLINE' }))).toBeUndefined()
  })

  it('leaves the empty phone hint off a moved vault’s line', () => {
    setIPhoneWording(true)
    try {
      const moved = rust({
        transport: 'relay',
        enrolled: true,
        status: { state: 'stopped', code: 'E_SYNC_VAULT_MOVED' },
      })
      for (const icloud of [ICLOUD, { available: false, account: null }] as const)
        expect(icloudLine({ kind: 'moved' }, moved, icloud, false).text).toBe(
          'Vault moved to iCloud',
        )
    } finally {
      setIPhoneWording(false)
    }
  })

  it('marks Sync in the phone’s Settings only when the owner has something to do', () => {
    expect(syncNeedsOwner(stopped('E_SYNC_ICLOUD_DELETED'))).toBe(true)
    expect(syncNeedsOwner(paused('E_SYNC_ICLOUD_SIGNED_OUT'))).toBe(true)
    expect(syncNeedsOwner(paused('E_SYNC_ICLOUD_BUSY', later))).toBe(false)
    expect(syncNeedsOwner(rust({ icloudJoin: { state: 'joined' } }))).toBe(false)
    expect(syncNeedsOwner(rust({}))).toBe(false)
  })
})

describe('the main window’s notice', () => {
  it('words each iCloud cause, never the relay’s quota', () => {
    for (const snapshot of [
      paused('E_SYNC_ICLOUD_SIGNED_OUT'),
      paused('E_SYNC_ICLOUD_RESTRICTED'),
      paused('E_SYNC_ICLOUD_FULL'),
      paused('E_SYNC_ICLOUD_BUSY', later),
      stopped('E_SYNC_ICLOUD_ACCOUNT_CHANGED'),
      stopped('E_SYNC_ICLOUD_DELETED'),
      rust({ status: { state: 'offline', code: 'E_SYNC_ICLOUD_ACCOUNT_UNAVAILABLE' } }),
    ]) {
      const [text, ...rest] = syncNoticeMessages(snapshot, false, null)
      expect(rest).toEqual([])
      expect(text).toContain('iCloud')
      expect(text).not.toMatch(/relay|quota/i)
    }
  })

  it('tells what to do in Settings > Sync for the states that wait on the owner', () => {
    for (const snapshot of [
      stopped('E_SYNC_ICLOUD_ACCOUNT_CHANGED'),
      stopped('E_SYNC_ICLOUD_DELETED'),
      rust({
        transport: 'relay',
        enrolled: true,
        status: { state: 'stopped', code: 'E_SYNC_VAULT_MOVED' },
      }),
    ]) {
      expect(syncNoticeMessages(snapshot, false, null)[0]).toContain('Settings > Sync')
    }
  })

  it('words a later stop of a joined device, not the join', () => {
    const joined = (status: Record<string, unknown>) =>
      rust({ icloudJoin: { state: 'joined' }, status })
    expect(
      syncNoticeMessages(joined({ state: 'stopped', code: 'E_LICENCE_REQUIRED' }), false, null),
    ).toEqual([expect.stringMatching(/needs a Devot license/)])
    expect(
      syncNoticeMessages(joined({ state: 'stopped', code: 'E_SYNC_CLOCK_SKEW' }), false, null),
    ).toEqual([expect.stringMatching(/clock/)])
    expect(syncNoticeMessages(joined({ state: 'offline' }), false, null)).toEqual([])
  })

  it('asks about the Apple ID’s vault while sync is still off here', () => {
    const ask = rust({ enabled: false, vault: false, icloudJoin: { state: 'ask', notes: 4 } })
    expect(syncNoticeMessages(ask, false, null)).toEqual([
      icloudNotice({ kind: 'ask', notes: 4 }, false),
    ])
    const missing = rust({
      enabled: false,
      vault: false,
      icloudJoin: { state: 'fallback', reason: 'missing' },
    })
    expect(syncNoticeMessages(missing, false, null)[0]).toMatch(/pairing code or the recovery key/)
    expect(
      syncNoticeMessages(
        rust({ enabled: false, vault: false, icloudJoin: { state: 'declined' } }),
        false,
        null,
      ),
    ).toEqual([])
  })
})

describe('Rust’s reports', () => {
  it('reads the account’s state, and treats anything else as no iCloud', () => {
    expect(readICloudStatus({ available: true, account: 'noAccount' })).toEqual({
      available: true,
      account: 'noAccount',
    })
    expect(readICloudStatus({ available: false, account: null })).toEqual({
      available: false,
      account: null,
    })
    expect(readICloudStatus('x')).toEqual({ available: false, account: null })
  })

  it('drops a look it cannot read', () => {
    expect(rust({ icloudJoin: { state: 'maybe' } }).icloudJoin).toBeNull()
    expect(rust({ icloudJoin: { state: 'ask', notes: -1 } }).icloudJoin).toEqual({
      state: 'ask',
      notes: null,
      reason: null,
      code: null,
    })
  })

  it('has a message for every iCloud and transport-switch code Rust sends', () => {
    const root = join(import.meta.dirname, '../../src-tauri/src/sync')
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((f) =>
      f.endsWith('.rs'),
    )
    const codes = new Set<string>()
    for (const file of files) {
      for (const [code] of readFileSync(join(root, file), 'utf8').matchAll(
        /E_SYNC_(?:ICLOUD_[A-Z_]+|CLOUDKIT_UNAVAILABLE|MOVED_REFUSED|VAULT_MOVED)\b/g,
      ))
        codes.add(code)
    }
    expect(codes.size).toBeGreaterThan(10)
    expect([...codes].filter((code) => !WHY[code])).toEqual([])
  })
})
