import { describe, expect, it } from 'vitest'
import { LICENCE_UNKNOWN, type LicenceSnapshot } from '../licence'
import { licenceRow } from './settingsRows'

const DAY = 24 * 60 * 60 * 1000
const gated = (patch: Partial<LicenceSnapshot>): LicenceSnapshot => ({
  ...LICENCE_UNKNOWN,
  gated: true,
  ...patch,
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
      gated({ trial: { state: 'running', endsAt: days * DAY, code: null } })
    expect(licenceRow(trial(10), 0)).toEqual({
      label: 'Trial, 10 days left',
      needsAttention: false,
    })
    expect(licenceRow(trial(3), 0).needsAttention).toBe(true)
  })

  it('asks for attention once the trial is over', () => {
    const over = gated({ trial: { state: 'running', endsAt: DAY, code: null } })
    expect(licenceRow(over, 2 * DAY).needsAttention).toBe(true)
  })
})
