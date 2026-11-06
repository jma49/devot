import { describe, expect, it } from 'vitest'
import { LICENCE_UNKNOWN, type LicenceSnapshot } from '../licence'
import { licenceRow, licenceRowChangesAt, phonePanes, welcomeDue } from './settingsRows'

const DAY = 24 * 60 * 60 * 1000
const gated = (patch: Partial<LicenceSnapshot>): LicenceSnapshot => ({
  ...LICENCE_UNKNOWN,
  gated: true,
  ...patch,
})

describe('phonePanes', () => {
  const panes = ['general', 'appearance', 'sync'] as const
  it('lists General only when this build can send crash reports, its one setting', () => {
    expect(phonePanes(panes, true)).toEqual(['general', 'appearance', 'sync'])
    expect(phonePanes(panes, false)).toEqual(['appearance', 'sync'])
  })
})

describe('the Licence row', () => {
  it('is quiet for a valid licence', () => {
    expect(licenceRow(gated({ state: 'valid', plan: 'pro' }), 0)).toEqual({
      label: 'Pro',
      needsAttention: false,
    })
  })

  it('counts the trial days, and asks for attention in the last three', () => {
    const trial = (days: number) =>
      gated({ trial: { state: 'running', endsAt: days * DAY, code: null, source: 'keychain' } })
    expect(licenceRow(trial(10), 0)).toEqual({
      label: 'Trial, 10 days left',
      needsAttention: false,
    })
    expect(licenceRow(trial(3), 0).needsAttention).toBe(true)
  })

  it('asks for attention once the trial is over', () => {
    const over = gated({ trial: { state: 'running', endsAt: DAY, code: null, source: 'keychain' } })
    expect(licenceRow(over, 2 * DAY).needsAttention).toBe(true)
  })
})

describe('when the Licence row next changes', () => {
  const trial = (endsAt: number | null) =>
    gated({ trial: { state: 'running', endsAt, code: null, source: 'keychain' } })

  it('is when the trial drops a day, and when it ends', () => {
    const ends = 10 * DAY
    expect(licenceRowChangesAt(trial(ends), 0)).toBe(DAY)
    expect(licenceRowChangesAt(trial(ends), DAY / 2)).toBe(DAY)
    expect(licenceRowChangesAt(trial(ends), DAY)).toBe(2 * DAY)
    expect(licenceRowChangesAt(trial(ends), ends - DAY / 2)).toBe(ends)
    const at = licenceRowChangesAt(trial(ends), DAY / 2)!
    expect(licenceRow(trial(ends), at - 1).label).toBe('Trial, 10 days left')
    expect(licenceRow(trial(ends), at).label).toBe('Trial, 9 days left')
  })

  it('is never while nothing in the row depends on the time', () => {
    expect(licenceRowChangesAt(trial(null), 0)).toBeNull()
    expect(licenceRowChangesAt(trial(DAY), 2 * DAY)).toBeNull()
    expect(licenceRowChangesAt(gated({ state: 'valid', plan: 'pro' }), 0)).toBeNull()
  })
})

describe('the Licence row in an App Store build', () => {
  const store = (
    appStore: Partial<NonNullable<LicenceSnapshot['appStore']>>,
    trial: Partial<NonNullable<LicenceSnapshot['trial']>> = {},
  ) =>
    gated({
      trial: { state: 'available', endsAt: null, code: null, source: 'purchase', ...trial },
      appStore: { pro: false, code: null, takesKeys: true, ...appStore },
    })

  it('shows Pro for a Devot Pro purchase', () => {
    expect(licenceRow(store({ pro: true }, { state: 'ended' }), 0)).toEqual({
      label: 'Pro',
      needsAttention: false,
    })
  })

  it('stays quiet while the purchases are read', () => {
    expect(licenceRow(store({ code: 'E_APP_STORE_UNREAD' }), 0)).toEqual({
      label: 'Checking',
      needsAttention: false,
    })
  })

  it('asks for attention when the trial has not started', () => {
    expect(licenceRow(store({}), 0)).toEqual({ label: 'Trial not started', needsAttention: true })
  })
})

describe('the purchase sheet at launch', () => {
  const store = (
    appStore: Partial<NonNullable<LicenceSnapshot['appStore']>> = {},
    trial: Partial<NonNullable<LicenceSnapshot['trial']>> = {},
    patch: Partial<LicenceSnapshot> = {},
  ) =>
    gated({
      trial: { state: 'available', endsAt: null, code: null, source: 'purchase', ...trial },
      appStore: { pro: false, code: null, takesKeys: true, ...appStore },
      ...patch,
    })

  it('opens before the trial and once it has ended', () => {
    expect(welcomeDue(store(), 0)).toBe(true)
    expect(welcomeDue(store({}, { state: 'ended' }), 0)).toBe(true)
    expect(welcomeDue(store({}, { state: 'running', endsAt: DAY }), 2 * DAY)).toBe(true)
  })

  it('stays shut while anything unlocks or the purchases are not known', () => {
    expect(welcomeDue(store({}, { state: 'running', endsAt: DAY }), 0)).toBe(false)
    expect(welcomeDue(store({ pro: true }), 0)).toBe(false)
    expect(welcomeDue(store({ code: 'E_APP_STORE_UNREAD' }), 0)).toBe(false)
    expect(welcomeDue(store({}, { code: 'E_LICENCE_KEYCHAIN' }), 0)).toBe(false)
    expect(welcomeDue(store({}, {}, { state: 'valid', plan: 'pro' }), 0)).toBe(false)
  })

  it('never opens in a build sold elsewhere', () => {
    expect(
      welcomeDue(
        gated({ trial: { state: 'ended', endsAt: 0, code: null, source: 'keychain' } }),
        DAY,
      ),
    ).toBe(false)
  })
})
