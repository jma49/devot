// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { glassHandlers } from './glass'

const KEY = 'devot.phone.glassTransparency'
const surface = () => document.documentElement.style.getPropertyValue('--phone-glass-surface')

afterEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('style')
})

describe('the glass operations', () => {
  it("hand the native store the page's stored transparency once, or nothing when there is none", async () => {
    const handlers = glassHandlers()
    await expect(handlers['glass.get']!({})).resolves.toStrictEqual({ transparency: null })
    localStorage.setItem(KEY, '40')
    await expect(handlers['glass.get']!({})).resolves.toStrictEqual({ transparency: 40 })
    localStorage.setItem(KEY, '900')
    await expect(handlers['glass.get']!({})).resolves.toStrictEqual({ transparency: 100 })
  })

  it("put the native store's value on the page's glass and keep it for the next launch", async () => {
    await expect(glassHandlers()['glass.set']!({ transparency: -100 })).resolves.toStrictEqual({})
    expect(surface()).toContain('var(--color-phone-glass-opaque) 100%')
    expect(localStorage.getItem(KEY)).toBe('-100')
  })

  it('refuse a value the slider cannot hold', async () => {
    for (const transparency of [140, 2.5, '20', null])
      await expect(glassHandlers()['glass.set']!({ transparency })).rejects.toThrow(
        'E_SCREENS_ARGS_INVALID',
      )
    expect(localStorage.getItem(KEY)).toBeNull()
  })
})
