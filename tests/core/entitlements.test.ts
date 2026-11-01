import { describe, expect, it } from 'vitest'
import {
  FEATURES,
  LICENCE_STATES,
  PLAN_GATED_FEATURES,
  TRIAL_STATES,
  createEntitlements,
  type LicenceEntitlements,
  type TrialState,
} from '../../src/core/entitlements'

const valid: LicenceEntitlements = { enforced: true, state: 'valid', plan: 'pro' }

const withLicence = (licence: LicenceEntitlements | null) =>
  createEntitlements({ source: { read: () => licence } })

describe('what a licence unlocks', () => {
  it('gates editing, sync, AI and semantic search, and nothing else', () => {
    expect([...PLAN_GATED_FEATURES].sort()).toEqual([
      'aiProviders',
      'editing',
      'semanticSearch',
      'sync',
    ])
  })

  it('grants every gated feature with a valid pro licence', () => {
    const e = withLicence(valid)
    for (const f of FEATURES) expect(e.has(f)).toBe(true)
  })
})

describe('without a valid licence', () => {
  it('keeps the free features and withholds the gated ones', () => {
    for (const state of LICENCE_STATES.filter((s) => s !== 'valid')) {
      const e = withLicence({ enforced: true, state, plan: state === 'none' ? null : 'pro' })
      expect(e.has('localNotes')).toBe(true)
      expect(e.has('sharing')).toBe(true)
      for (const f of PLAN_GATED_FEATURES) expect(e.has(f)).toBe(false)
    }
  })

  it('withholds them from a valid licence whose device has no live seat', () => {
    for (const activation of ['required', 'expired'] as const) {
      const e = withLicence({ ...valid, activation })
      for (const f of PLAN_GATED_FEATURES) expect(e.has(f)).toBe(false)
      expect(e.has('localNotes')).toBe(true)
    }
    expect(withLicence({ ...valid, activation: 'active' }).has('editing')).toBe(true)
  })

  it('withholds gated features when the licence is not known or there is no source', () => {
    expect(withLicence(null).has('sync')).toBe(false)
    expect(createEntitlements().has('aiProviders')).toBe(false)
    expect(createEntitlements().has('localNotes')).toBe(true)
  })

  it('withholds them from a valid state without a plan', () => {
    expect(withLicence({ ...valid, plan: null }).has('sync')).toBe(false)
  })
})

describe('the trial', () => {
  const unlicensed = (trial?: TrialState | null) =>
    withLicence({
      enforced: true,
      state: 'none',
      plan: null,
      ...(trial === undefined ? {} : { trial }),
    })

  it('grants every gated feature while it runs', () => {
    const e = unlicensed('running')
    for (const f of FEATURES) expect(e.has(f)).toBe(true)
  })

  it('leaves notes readable but not editable once it ended, nor sync and AI', () => {
    for (const trial of ['ended', null, undefined] as const) {
      const e = unlicensed(trial)
      expect(e.has('localNotes')).toBe(true)
      for (const f of PLAN_GATED_FEATURES) expect(e.has(f)).toBe(false)
    }
  })

  it('runs for a revoked or invalid licence too, and a valid licence needs none', () => {
    for (const state of ['revoked', 'invalid'] as const) {
      const e = withLicence({ enforced: true, state, plan: null, trial: 'running' })
      expect(e.has('editing')).toBe(true)
    }
    const licensed = withLicence({ ...valid, trial: 'ended' })
    for (const f of FEATURES) expect(licensed.has(f)).toBe(true)
  })

  it('has two states', () => {
    expect(TRIAL_STATES).toEqual(['running', 'ended'])
  })
})

describe('a build that gates nothing', () => {
  it('grants every feature without a licence', () => {
    const e = withLicence({ enforced: false, state: 'none', plan: null })
    for (const f of FEATURES) expect(e.has(f)).toBe(true)
  })
})

describe('the source', () => {
  it('is read on every call, so adding or removing a licence takes effect at once', () => {
    let current: LicenceEntitlements | null = valid
    const e = createEntitlements({ source: { read: () => current } })
    expect(e.has('sync')).toBe(true)
    current = { enforced: true, state: 'none', plan: null }
    expect(e.has('sync')).toBe(false)
    current = { enforced: true, state: 'revoked', plan: 'pro' }
    expect(e.has('sync')).toBe(false)
  })

  it('follows a gated list it is given', () => {
    const e = createEntitlements({ source: { read: () => null }, gated: ['sync'] })
    expect(e.has('aiProviders')).toBe(true)
    expect(e.has('sync')).toBe(false)
  })
})
