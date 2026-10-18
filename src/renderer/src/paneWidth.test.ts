import { describe, expect, it } from 'vitest'
import {
  LIST_PANE,
  SIDEBAR_PANE,
  clampPaneWidth,
  paneWidthForKey,
  paneWidthStore,
} from './paneWidth'

function memory(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial))
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  }
}

describe('the note list width', () => {
  it('is 300 px by default, between 220 and 500 px', () => {
    expect(LIST_PANE.default).toBe(300)
    expect(LIST_PANE.min).toBe(220)
    expect(LIST_PANE.max).toBe(500)
  })

  it('stays between its minimum and maximum, in whole pixels', () => {
    expect(clampPaneWidth(LIST_PANE, 100)).toBe(220)
    expect(clampPaneWidth(LIST_PANE, 900)).toBe(500)
    expect(clampPaneWidth(LIST_PANE, 333.6)).toBe(334)
    expect(clampPaneWidth(LIST_PANE, Number.NaN)).toBe(300)
    expect(clampPaneWidth(LIST_PANE, Number.POSITIVE_INFINITY)).toBe(300)
  })

  it('opens at the default until a width is remembered', () => {
    expect(paneWidthStore(LIST_PANE, memory()).read()).toBe(300)
    expect(paneWidthStore(LIST_PANE, undefined).read()).toBe(300)
  })

  it('remembers the width a drag ended at, clamped', () => {
    const storage = memory()
    paneWidthStore(LIST_PANE, storage).write(412.2)
    expect(storage.items.get('devot.list.width')).toBe('412')
    expect(paneWidthStore(LIST_PANE, storage).read()).toBe(412)
    paneWidthStore(LIST_PANE, storage).write(1200)
    expect(paneWidthStore(LIST_PANE, storage).read()).toBe(500)
  })

  it('clamps or ignores a remembered value it cannot use', () => {
    expect(paneWidthStore(LIST_PANE, memory({ 'devot.list.width': '9999' })).read()).toBe(500)
    expect(paneWidthStore(LIST_PANE, memory({ 'devot.list.width': '12' })).read()).toBe(220)
    expect(paneWidthStore(LIST_PANE, memory({ 'devot.list.width': 'wide' })).read()).toBe(300)
    expect(paneWidthStore(LIST_PANE, memory({ 'devot.list.width': '' })).read()).toBe(300)
  })

  it('works on with storage that fails', () => {
    const broken = {
      getItem: () => {
        throw new Error('off')
      },
      setItem: () => {
        throw new Error('full')
      },
    }
    expect(paneWidthStore(LIST_PANE, broken).read()).toBe(300)
    expect(() => paneWidthStore(LIST_PANE, broken).write(400)).not.toThrow()
  })
})

describe('listWidthForKey', () => {
  it('steps with the arrow keys, larger with Shift, within the limits', () => {
    expect(paneWidthForKey(LIST_PANE, 'ArrowRight', false, 300)).toBe(310)
    expect(paneWidthForKey(LIST_PANE, 'ArrowLeft', false, 300)).toBe(290)
    expect(paneWidthForKey(LIST_PANE, 'ArrowRight', true, 300)).toBe(350)
    expect(paneWidthForKey(LIST_PANE, 'ArrowLeft', true, 300)).toBe(250)
    expect(paneWidthForKey(LIST_PANE, 'ArrowRight', false, 500)).toBe(500)
    expect(paneWidthForKey(LIST_PANE, 'ArrowLeft', false, 220)).toBe(220)
  })

  it('goes to the ends with Home and End and back to the default with Enter', () => {
    expect(paneWidthForKey(LIST_PANE, 'Home', false, 400)).toBe(220)
    expect(paneWidthForKey(LIST_PANE, 'End', false, 400)).toBe(500)
    expect(paneWidthForKey(LIST_PANE, 'Enter', false, 400)).toBe(300)
  })

  it('leaves other keys alone', () => {
    expect(paneWidthForKey(LIST_PANE, 'ArrowUp', false, 300)).toBeUndefined()
    expect(paneWidthForKey(LIST_PANE, 'a', false, 300)).toBeUndefined()
  })
})

describe('the sidebar width', () => {
  it('is 200 px by default, between 170 and 500 px', () => {
    expect(SIDEBAR_PANE.default).toBe(200)
    expect(SIDEBAR_PANE.min).toBe(170)
    expect(SIDEBAR_PANE.max).toBe(500)
  })

  it('clamps and steps within its own bounds', () => {
    expect(clampPaneWidth(SIDEBAR_PANE, 100)).toBe(170)
    expect(clampPaneWidth(SIDEBAR_PANE, 900)).toBe(500)
    expect(clampPaneWidth(SIDEBAR_PANE, Number.NaN)).toBe(200)
    expect(paneWidthForKey(SIDEBAR_PANE, 'ArrowLeft', false, 175)).toBe(170)
    expect(paneWidthForKey(SIDEBAR_PANE, 'ArrowRight', true, 200)).toBe(250)
    expect(paneWidthForKey(SIDEBAR_PANE, 'Home', false, 300)).toBe(170)
    expect(paneWidthForKey(SIDEBAR_PANE, 'End', false, 300)).toBe(500)
    expect(paneWidthForKey(SIDEBAR_PANE, 'Enter', false, 300)).toBe(200)
  })

  it('is kept under its own key, apart from the note list width', () => {
    const storage = memory({ 'devot.list.width': '400' })
    paneWidthStore(SIDEBAR_PANE, storage).write(260.4)
    expect(storage.items.get('devot.sidebar.width')).toBe('260')
    expect(paneWidthStore(SIDEBAR_PANE, storage).read()).toBe(260)
    expect(paneWidthStore(LIST_PANE, storage).read()).toBe(400)
    expect(paneWidthStore(SIDEBAR_PANE, memory({ 'devot.sidebar.width': '9999' })).read()).toBe(500)
    expect(paneWidthStore(SIDEBAR_PANE, undefined).read()).toBe(200)
  })
})
