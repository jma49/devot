import { describe, expect, it } from 'vitest'
import {
  FEATURES,
  OFFLINE_GRACE_MS,
  createEntitlements,
  type AccountEntitlements,
  type Feature,
} from '../../src/core/entitlements'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000
const gated: readonly Feature[] = ['sync', 'aiProviders']

const withAccount = (account: AccountEntitlements | null, at = NOW) =>
  createEntitlements({ source: { read: () => account }, now: () => at, gated })

describe('entitlements today', () => {
  it('makes every feature available with no account source', () => {
    const e = createEntitlements()
    for (const f of FEATURES) expect(e.has(f)).toBe(true)
  })
})

describe('signed out', () => {
  it('keeps ungated features and withholds gated ones', () => {
    const e = withAccount(null)
    expect(e.has('localNotes')).toBe(true)
    expect(e.has('sync')).toBe(false)
  })

  it('behaves the same with no source', () => {
    const e = createEntitlements({ gated })
    expect(e.has('localNotes')).toBe(true)
    expect(e.has('aiProviders')).toBe(false)
  })
})

describe('signed in', () => {
  const account = { granted: ['sync'] as Feature[], confirmedAt: NOW - DAY }

  it('grants what the account lists', () => {
    const e = withAccount(account)
    expect(e.has('sync')).toBe(true)
    expect(e.has('aiProviders')).toBe(false)
    expect(e.has('localNotes')).toBe(true)
  })

  it('keeps the grant offline up to the grace period', () => {
    const edge = { ...account, confirmedAt: NOW - OFFLINE_GRACE_MS }
    expect(withAccount(edge).has('sync')).toBe(true)
  })

  it('drops gated features after the grace period but keeps local ones', () => {
    const stale = { ...account, confirmedAt: NOW - OFFLINE_GRACE_MS - 1 }
    const e = withAccount(stale)
    expect(e.has('sync')).toBe(false)
    expect(e.has('localNotes')).toBe(true)
  })

  it('withholds gated features when the confirmed time is not a number', () => {
    expect(withAccount({ ...account, confirmedAt: Number.NaN }).has('sync')).toBe(false)
    expect(withAccount({ ...account, confirmedAt: Number.POSITIVE_INFINITY }).has('sync')).toBe(
      false,
    )
  })

  it('does not extend the grace period when the clock is set back', () => {
    expect(withAccount({ ...account, confirmedAt: NOW + DAY }).has('sync')).toBe(false)
  })

  it('reads the source on every call, so sign-out takes effect at once', () => {
    let current: AccountEntitlements | null = account
    const e = createEntitlements({ source: { read: () => current }, now: () => NOW, gated })
    expect(e.has('sync')).toBe(true)
    current = null
    expect(e.has('sync')).toBe(false)
  })
})
