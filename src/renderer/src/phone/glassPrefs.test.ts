import { describe, expect, it } from 'vitest'
import { glassSurface, readGlassPrefs } from './glassPrefs'

describe('readGlassPrefs', () => {
  it('starts as the design glass', () => {
    expect(readGlassPrefs(null, null)).toEqual({ style: 'glass', transparency: 0 })
  })

  it('reads a stored choice and refuses anything else', () => {
    expect(readGlassPrefs('classic', '40')).toEqual({ style: 'classic', transparency: 40 })
    expect(readGlassPrefs('other', 'x')).toEqual({ style: 'glass', transparency: 0 })
    expect(readGlassPrefs(null, '900').transparency).toBe(100)
    expect(readGlassPrefs(null, '-900').transparency).toBe(-100)
  })
})

describe('glassSurface', () => {
  it('leaves the design tint at zero', () => {
    expect(glassSurface(0)).toBe('var(--color-phone-glass)')
  })

  it('reaches the opaque colour at -100', () => {
    expect(glassSurface(-100)).toContain('var(--color-phone-glass-opaque) 100%')
  })

  it('halves the tint at 100, twice as clear', () => {
    expect(glassSurface(100)).toContain('var(--color-phone-glass) 50%, transparent')
  })
})
