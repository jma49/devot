import { describe, expect, it } from 'vitest'
import { collectEarlyKeys } from './earlyKeys'

// Node has no KeyboardEvent; the fields the collector reads are enough.
const key = (k: string, init: Partial<KeyboardEvent> = {}) =>
  Object.assign(new Event('keydown', { cancelable: true }), {
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    isComposing: false,
    keyCode: 0,
    ...init,
  })

describe('collectEarlyKeys', () => {
  it('keeps the characters typed while the keyboard is free, in order, and takes them', () => {
    const target = new EventTarget()
    const early = collectEarlyKeys(target, () => true)
    const a = key('A')
    target.dispatchEvent(a)
    for (const k of ['l', 'p', 'h', 'a', ' ']) target.dispatchEvent(key(k))
    expect(a.defaultPrevented).toBe(true)
    expect(early.stop()).toBe('Alpha ')
    target.dispatchEvent(key('x'))
    expect(early.stop()).toBe('Alpha ')
  })

  it('leaves shortcuts, named keys, handled keys and keys for a busy keyboard alone', () => {
    const target = new EventTarget()
    let free = true
    const early = collectEarlyKeys(target, () => free)
    const shortcut = key('n', { metaKey: true })
    target.dispatchEvent(shortcut)
    target.dispatchEvent(key('Enter'))
    const handled = key('q')
    handled.preventDefault()
    target.dispatchEvent(handled)
    free = false
    target.dispatchEvent(key('z'))
    expect(shortcut.defaultPrevented).toBe(false)
    expect(early.stop()).toBe('')
  })
})
