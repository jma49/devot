import { describe, expect, it } from 'vitest'
import { COMPOSITION_END_KEY_MS, isImeKey, watchCompositions } from './ime'

function keyDown(fields: { key?: string; keyCode?: number; isComposing?: boolean } = {}) {
  const event = new Event('keydown')
  Object.assign(event, { key: 'Enter', keyCode: 13, isComposing: false, ...fields })
  return event as KeyboardEvent
}

function watched() {
  const clock = { now: 1000 }
  const target = new EventTarget()
  const stop = watchCompositions(target, () => clock.now)
  const press = (fields?: Parameters<typeof keyDown>[0]) => {
    const event = keyDown(fields)
    target.dispatchEvent(event)
    return event
  }
  const endComposition = () => target.dispatchEvent(new Event('compositionend'))
  return { clock, press, endComposition, stop }
}

describe('isImeKey', () => {
  it('is true for a key typed into a composition', () => {
    expect(isImeKey(keyDown({ isComposing: true }))).toBe(true)
    expect(isImeKey(keyDown({ key: 'Escape', keyCode: 27, isComposing: true }))).toBe(true)
  })

  it('is true for a key the input method took, also once its composition ended', () => {
    // WebKit sends the Return or Escape that ends a composition after
    // compositionend, with key code 229 and isComposing false.
    expect(isImeKey(keyDown({ keyCode: 229 }))).toBe(true)
    expect(isImeKey(keyDown({ key: 'Escape', keyCode: 229 }))).toBe(true)
    expect(isImeKey(keyDown({ key: 'Process', keyCode: 0 }))).toBe(true)
  })

  it('is false for other keys', () => {
    expect(isImeKey(keyDown())).toBe(false)
    expect(isImeKey(keyDown({ key: 'Escape', keyCode: 27 }))).toBe(false)
    expect(isImeKey(keyDown({ key: 'a', keyCode: 65 }))).toBe(false)
  })
})

describe('watchCompositions', () => {
  it('counts the first key down right after a composition ends as its own', () => {
    const w = watched()
    w.endComposition()
    w.clock.now += COMPOSITION_END_KEY_MS - 1
    expect(isImeKey(w.press())).toBe(true)
    // Only that one: the next Return is the user's.
    expect(isImeKey(w.press())).toBe(false)
    w.stop()
  })

  it('leaves a later key, or one with no composition before it, to the page', () => {
    const w = watched()
    expect(isImeKey(w.press())).toBe(false)
    w.endComposition()
    w.clock.now += COMPOSITION_END_KEY_MS
    expect(isImeKey(w.press())).toBe(false)
    w.stop()
  })

  it('stops watching when asked', () => {
    const w = watched()
    w.stop()
    w.endComposition()
    expect(isImeKey(w.press())).toBe(false)
  })
})
