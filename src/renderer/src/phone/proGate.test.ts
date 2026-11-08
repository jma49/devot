import { describe, expect, it } from 'vitest'
import shared from '../../../../tests/fixtures/licence-gate.json'
import { t, type MessageKey } from '../i18n'
import { readLicence } from '../licence'
import { purchaseHeading } from './PhonePurchase'
import { lockSurface } from './requireEditing'

// The native gate (DevotScreens ProGateTests) reads the same table, so both shells agree.
const locked = (surface: string) => shared.states.filter((state) => state.surface === surface)

describe('the surface a locked write shows', () => {
  for (const state of locked('purchase')) {
    it(`${state.name}: ${state.note}, the purchase sheet headed for the gate`, () => {
      const licence = readLicence(state.licence)!
      expect(lockSurface(licence)).toStrictEqual({ kind: 'purchase' })
      expect(purchaseHeading(licence, true)).toBe(t(state.heading as MessageKey))
    })
  }
  for (const state of locked('pro')) {
    it(`${state.name}: ${state.note}, the ${state.sheet} Pro sheet`, () => {
      expect(lockSurface(readLicence(state.licence)!)).toStrictEqual({
        kind: 'pro',
        sheet: state.sheet,
      })
    })
  }
})
