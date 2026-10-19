import { describe, expect, it } from 'vitest'
import { applyMotion, reducesMotion } from './motionPreference'

describe('whether the windows animate', () => {
  it('animates always, as the system asks, or never', () => {
    expect(reducesMotion('always', true)).toBe(false)
    expect(reducesMotion('always', false)).toBe(false)
    expect(reducesMotion('system', true)).toBe(true)
    expect(reducesMotion('system', false)).toBe(false)
    expect(reducesMotion('off', false)).toBe(true)
    expect(reducesMotion('off', true)).toBe(true)
  })

  it('shows the choice on the root', () => {
    const root = { dataset: {} as DOMStringMap }
    applyMotion(true, root)
    expect(root.dataset['motion']).toBe('reduced')
    applyMotion(false, root)
    expect(root.dataset['motion']).toBe('full')
  })
})
