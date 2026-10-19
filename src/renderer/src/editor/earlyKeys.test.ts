import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collectEarlyKeys, earlyKeys, type EarlyKey } from './earlyKeys'

// Node has no KeyboardEvent; the fields the collector reads are enough.
const key = (k: string, init: Partial<KeyboardEvent> = {}) =>
  Object.assign(new Event('keydown', { cancelable: true }), {
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 0,
    ...init,
  })

const typeKeys = (target: EventTarget, keys: string[]) => {
  for (const k of keys) target.dispatchEvent(key(k))
}

const text = (keys: readonly EarlyKey[]) =>
  keys.map(({ key: k }) => (k.length === 1 ? k : `[${k}]`)).join('')

describe('collectEarlyKeys', () => {
  it('keeps the characters typed while the keyboard is free, in order, and takes them', () => {
    const target = new EventTarget()
    const early = collectEarlyKeys(target, () => true)
    const a = key('A')
    target.dispatchEvent(a)
    typeKeys(target, ['l', 'p', 'h', 'a', ' '])
    expect(a.defaultPrevented).toBe(true)
    expect(text(early.stop())).toBe('Alpha ')
    target.dispatchEvent(key('x'))
    expect(text(early.stop())).toBe('Alpha ')
  })

  it('keeps Enter, Backspace and Tab as edits, a Backspace taking back the character before it', () => {
    const target = new EventTarget()
    const early = collectEarlyKeys(target, () => true)
    typeKeys(target, ['Backspace', 'H', 'i', 'Enter', 'W', 'o', 'x', 'Backspace', 'Tab'])
    const outdent = key('Tab', { shiftKey: true })
    target.dispatchEvent(outdent)
    const keys = early.stop()
    expect(text(keys)).toBe('[Backspace]Hi[Enter]Wo[Tab][Tab]')
    expect(keys.at(-1)).toEqual({ key: 'Tab', shift: true })
    expect(outdent.defaultPrevented).toBe(true)
  })

  it('leaves shortcuts, other named keys, handled keys, input method keys and a busy keyboard alone', () => {
    const target = new EventTarget()
    let free = true
    const early = collectEarlyKeys(target, () => free)
    const shortcut = key('n', { metaKey: true })
    target.dispatchEvent(shortcut)
    typeKeys(target, ['Escape', 'ArrowLeft'])
    target.dispatchEvent(key('Enter', { isComposing: true }))
    target.dispatchEvent(key('Enter', { keyCode: 229 }))
    const handled = key('q')
    handled.preventDefault()
    target.dispatchEvent(handled)
    free = false
    target.dispatchEvent(key('z'))
    expect(shortcut.defaultPrevented).toBe(false)
    expect(early.stop()).toEqual([])
  })
})

describe('earlyKeys', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const setup = (field: string | undefined = 'title', canType = true) => {
    const target = new EventTarget()
    const givenBack: { field: string; keys: string }[] = []
    let focused: string | undefined = field
    const slot = earlyKeys<string>({
      target,
      isFree: () => true,
      leave: () => {
        const left = focused
        focused = undefined
        return left
      },
      canType: () => canType,
      giveBack: (to, keys) => {
        focused = to
        givenBack.push({ field: to, keys: text(keys) })
      },
      waitMs: 3000,
    })
    return { target, slot, givenBack }
  }

  it("keeps the keys for the new note's editor alone, whichever editor opens first", () => {
    const { target, slot, givenBack } = setup()
    const ticket = slot.start()
    typeKeys(target, ['t', 'y'])
    expect(slot.keptForAnother('note-3')).toBe(true)
    expect(slot.take('note-3')).toEqual([])
    ticket.claim('new')
    typeKeys(target, ['p', 'e', 'd'])
    expect(slot.keptForAnother('note-3')).toBe(true)
    expect(slot.keptForAnother('new')).toBe(false)
    expect(slot.take('note-3')).toEqual([])
    expect(text(slot.take('new'))).toBe('typed')
    expect(slot.take('new')).toEqual([])
    expect(slot.keptForAnother('note-3')).toBe(false)
    target.dispatchEvent(key('x'))
    vi.runAllTimers()
    expect(givenBack).toEqual([])
  })

  it('gives the keys back to the field left when the note is not made', () => {
    const { target, slot, givenBack } = setup()
    const ticket = slot.start()
    typeKeys(target, ['a', 'b', 'Enter'])
    ticket.fail()
    const late = key('c')
    target.dispatchEvent(late)
    expect(late.defaultPrevented).toBe(false)
    expect(givenBack).toEqual([{ field: 'title', keys: 'ab[Enter]' }])
    ticket.fail()
    expect(givenBack).toHaveLength(1)
  })

  it('gives the keys back to the field left when the note takes too long to be made', () => {
    const { target, slot, givenBack } = setup()
    const ticket = slot.start()
    typeKeys(target, ['a', 'b'])
    vi.advanceTimersByTime(3000)
    expect(givenBack).toEqual([{ field: 'title', keys: 'ab' }])
    const late = key('c')
    target.dispatchEvent(late)
    expect(late.defaultPrevented).toBe(false)
    ticket.claim('new')
    expect(slot.take('new')).toEqual([])
  })

  it('keeps the keys for a note already made, however late its editor opens', () => {
    const { target, slot, givenBack } = setup()
    slot.start().claim('new')
    typeKeys(target, ['a', 'b'])
    vi.advanceTimersByTime(3000)
    target.dispatchEvent(key('c'))
    expect(givenBack).toEqual([])
    expect(slot.keptForAnother('other')).toBe(false)
    expect(text(slot.take('new'))).toBe('ab')
  })

  it('keeps the keys for the note when the field left cannot take them back', () => {
    const { target, slot, givenBack } = setup('row', false)
    const ticket = slot.start()
    typeKeys(target, ['a'])
    vi.advanceTimersByTime(3000)
    expect(givenBack).toEqual([])
    ticket.claim('new')
    expect(text(slot.take('new'))).toBe('a')
  })

  it('still gives the keyboard back to the field left when a failed note had no keys', () => {
    const { slot, givenBack } = setup('row', false)
    slot.start().fail()
    expect(givenBack).toEqual([{ field: 'row', keys: '' }])
  })

  it('a second New Note gives the earlier keys back and leaves the same field', () => {
    const { target, slot, givenBack } = setup()
    slot.start()
    typeKeys(target, ['a'])
    const second = slot.start()
    expect(givenBack).toEqual([{ field: 'title', keys: 'a' }])
    typeKeys(target, ['b'])
    second.fail()
    expect(givenBack.at(-1)).toEqual({ field: 'title', keys: 'b' })
  })
})
