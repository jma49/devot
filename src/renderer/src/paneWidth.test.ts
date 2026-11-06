import { describe, expect, it } from 'vitest'
import {
  BOARD_PANE,
  LIST_PANE,
  SIDEBAR_PANE,
  clampPaneWidth,
  fittedBoardWidth,
  paneWidthForKey,
  paneWidthStore,
  shownPaneWidth,
} from './paneWidth'
import { memoryStorage } from '../../../tests/support/local-storage'

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
    expect(paneWidthStore(LIST_PANE, memoryStorage()).read()).toBe(300)
    expect(paneWidthStore(LIST_PANE, undefined).read()).toBe(300)
  })

  it('remembers the width a drag ended at, clamped', () => {
    const storage = memoryStorage()
    paneWidthStore(LIST_PANE, storage).write(412.2)
    expect(storage.items.get('devot.list.width')).toBe('412')
    expect(paneWidthStore(LIST_PANE, storage).read()).toBe(412)
    paneWidthStore(LIST_PANE, storage).write(1200)
    expect(paneWidthStore(LIST_PANE, storage).read()).toBe(500)
  })

  it('clamps or ignores a remembered value it cannot use', () => {
    expect(paneWidthStore(LIST_PANE, memoryStorage({ 'devot.list.width': '9999' })).read()).toBe(
      500,
    )
    expect(paneWidthStore(LIST_PANE, memoryStorage({ 'devot.list.width': '12' })).read()).toBe(220)
    expect(paneWidthStore(LIST_PANE, memoryStorage({ 'devot.list.width': 'wide' })).read()).toBe(
      300,
    )
    expect(paneWidthStore(LIST_PANE, memoryStorage({ 'devot.list.width': '' })).read()).toBe(300)
  })

  it('forgets the width set, so the pane opens at its default again', () => {
    const storage = memoryStorage({ 'devot.list.width': '412' })
    const store = paneWidthStore(LIST_PANE, storage)
    expect(store.stored()).toBe(412)
    store.clear()
    expect(storage.items.has('devot.list.width')).toBe(false)
    expect(store.stored()).toBeUndefined()
    expect(store.read()).toBe(300)
  })

  it('has no width set while none is stored or the stored one is not a number', () => {
    expect(paneWidthStore(LIST_PANE, memoryStorage()).stored()).toBeUndefined()
    expect(
      paneWidthStore(LIST_PANE, memoryStorage({ 'devot.list.width': 'wide' })).stored(),
    ).toBeUndefined()
    expect(paneWidthStore(LIST_PANE, memoryStorage({ 'devot.list.width': '12' })).stored()).toBe(
      220,
    )
  })

  it('works on with storage that fails', () => {
    const broken = {
      getItem: () => {
        throw new Error('off')
      },
      setItem: () => {
        throw new Error('full')
      },
      removeItem: () => {
        throw new Error('off')
      },
    }
    expect(paneWidthStore(LIST_PANE, broken).read()).toBe(300)
    expect(() => paneWidthStore(LIST_PANE, broken).write(400)).not.toThrow()
    expect(() => paneWidthStore(LIST_PANE, broken).clear()).not.toThrow()
    expect(paneWidthStore(LIST_PANE, broken).stored()).toBeUndefined()
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

  it('goes to the ends with Home and End, and Enter forgets the width set', () => {
    expect(paneWidthForKey(LIST_PANE, 'Home', false, 400)).toBe(220)
    expect(paneWidthForKey(LIST_PANE, 'End', false, 400)).toBe(500)
    expect(paneWidthForKey(LIST_PANE, 'Enter', false, 400)).toBe('reset')
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
    expect(paneWidthForKey(SIDEBAR_PANE, 'Enter', false, 300)).toBe('reset')
  })

  it('is kept under its own key, apart from the note list width', () => {
    const storage = memoryStorage({ 'devot.list.width': '400' })
    paneWidthStore(SIDEBAR_PANE, storage).write(260.4)
    expect(storage.items.get('devot.sidebar.width')).toBe('260')
    expect(paneWidthStore(SIDEBAR_PANE, storage).read()).toBe(260)
    expect(paneWidthStore(LIST_PANE, storage).read()).toBe(400)
    expect(
      paneWidthStore(SIDEBAR_PANE, memoryStorage({ 'devot.sidebar.width': '9999' })).read(),
    ).toBe(500)
    expect(paneWidthStore(SIDEBAR_PANE, undefined).read()).toBe(200)
  })
})

describe('the board width', () => {
  it('fits its columns exactly until the user sets a width: 964 px for five, 774 for four', () => {
    expect(fittedBoardWidth(5)).toBe(964)
    expect(fittedBoardWidth(4)).toBe(774)
    expect(BOARD_PANE.default).toBe(964)
  })

  it('keeps a fitted width within the pane’s limits', () => {
    expect(fittedBoardWidth(1)).toBe(BOARD_PANE.min)
    expect(fittedBoardWidth(20)).toBe(BOARD_PANE.max)
  })

  it('shows the width the user set, else the fitted one, else the default', () => {
    expect(shownPaneWidth(BOARD_PANE, 700, 774)).toBe(700)
    expect(shownPaneWidth(BOARD_PANE, undefined, 774)).toBe(774)
    expect(shownPaneWidth(BOARD_PANE, undefined, undefined)).toBe(964)
    expect(shownPaneWidth(LIST_PANE, undefined, undefined)).toBe(300)
    expect(shownPaneWidth(BOARD_PANE, 99_999, 774)).toBe(BOARD_PANE.max)
  })

  it('is shared by the board and the gallery, and a reset returns both to the fitted width', () => {
    const storage = memoryStorage()
    const store = paneWidthStore(BOARD_PANE, storage)
    store.write(1100)
    expect(storage.items.get('devot.board.width')).toBe('1100')
    expect(shownPaneWidth(BOARD_PANE, store.stored(), fittedBoardWidth(4))).toBe(1100)
    store.clear()
    expect(shownPaneWidth(BOARD_PANE, store.stored(), fittedBoardWidth(4))).toBe(774)
  })
})
