import { describe, expect, it } from 'vitest'
import { keyboardCover, keyboardOpen } from './useKeyboard'

describe('the on-screen keyboard', () => {
  it('covers what the visual viewport loses at the bottom', () => {
    expect(keyboardCover(844, 553, 0)).toBe(291)
    expect(keyboardCover(844, 553, 20)).toBe(271)
    expect(keyboardCover(844, 844, 0)).toBe(0)
  })

  it('is open only when it covers more than a shortcut bar', () => {
    expect(keyboardOpen(291)).toBe(true)
    expect(keyboardOpen(55)).toBe(false)
  })
})
