import { describe, expect, it } from 'vitest'
import { DEFAULT_NOTEBOOK_SYMBOL, NOTEBOOK_ICON_CATEGORIES } from '../../core/notebookIcons'
import { en } from './i18n/en'
import { gridStep } from './iconGrid'
import { symbolFor } from './icons/symbols'

describe('gridStep', () => {
  // 10 cells, 4 to a row: 0-3, 4-7, 8-9.
  const step = (key: string, at: number) => gridStep(key, at, 10, 4)

  it('steps one cell left and right, never past either end', () => {
    expect(step('ArrowRight', 3)).toBe(4)
    expect(step('ArrowLeft', 4)).toBe(3)
    expect(step('ArrowLeft', 0)).toBe(0)
    expect(step('ArrowRight', 9)).toBe(9)
  })

  it('steps a row up and down, staying put where there is no cell', () => {
    expect(step('ArrowDown', 1)).toBe(5)
    expect(step('ArrowUp', 5)).toBe(1)
    expect(step('ArrowUp', 2)).toBe(2)
    // The last row is short: no cell under 6.
    expect(step('ArrowDown', 6)).toBe(6)
    expect(step('ArrowDown', 5)).toBe(9)
  })

  it('goes to the first and last cell with Home and End', () => {
    expect(step('Home', 6)).toBe(0)
    expect(step('End', 2)).toBe(9)
  })

  it('leaves other keys and an empty grid alone', () => {
    expect(step('a', 3)).toBeUndefined()
    expect(gridStep('ArrowRight', 0, 0, 4)).toBeUndefined()
  })
})

describe('the icon picker categories', () => {
  it('each have a label in the catalog', () => {
    const missing = NOTEBOOK_ICON_CATEGORIES.filter((id) => !(`notebookIcon.category.${id}` in en))
    expect(missing).toEqual([])
  })
})

describe('the default notebook icon', () => {
  it('is the symbol the notebook icon has always been', () => {
    expect(DEFAULT_NOTEBOOK_SYMBOL).toBe(symbolFor('notebook'))
  })
})
