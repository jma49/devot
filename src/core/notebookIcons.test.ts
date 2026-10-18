import { describe, expect, it } from 'vitest'
import catalog from '../../design/icons/notebook-symbols.json'
import raw from '../../design/icons/notebook-symbols.json?raw'
import {
  CATEGORY_ICONS,
  DEFAULT_NOTEBOOK_SYMBOL,
  NOTEBOOK_ICON_CATEGORIES,
  NOTEBOOK_SYMBOLS,
  isNotebookSymbol,
  searchNotebookSymbols,
  symbolsInCategory,
} from './notebookIcons'

/**
 * Symbols that depict Apple products or services, which Devot does not use
 * (docs/adr/0001-sf-symbols-rendered-at-runtime.md), and names the system
 * reserves for one Apple app or framework.
 */
const BANNED_PREFIXES = [
  'iphone',
  'ipad',
  'ipod',
  'applewatch',
  'airpods',
  'airpod',
  'airtag',
  'airplay',
  'macbook',
  'macmini',
  'macpro',
  'macstudio',
  'imac',
  'display',
  'desktopcomputer',
  'laptopcomputer',
  'icloud',
  'facetime',
  'appletv',
  'homepod',
  'hifispeaker',
  'visionpro',
  'vision.pro',
  'shareplay',
  'applelogo',
  'apple.',
  'pencil.tip',
  'video',
  'logo',
]

describe('notebook icon catalog', () => {
  it('names symbols as Rust checks them: lowercase ASCII, digits and dots, at most 64 bytes', () => {
    for (const { name } of NOTEBOOK_SYMBOLS) {
      expect(name).toMatch(/^[a-z0-9.]{1,64}$/)
    }
  })

  it('lists each symbol once', () => {
    // JSON.parse keeps the last of two equal keys: count them in the text.
    const symbols = raw.slice(raw.indexOf('"symbols"'))
    const keys = [...symbols.matchAll(/^ {4}"([^"]+)": \{/gm)].map((m) => m[1])
    expect(keys.length).toBe(NOTEBOOK_SYMBOLS.length)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('has the twelve categories in order, each with symbols and a catalog icon', () => {
    expect(catalog.categories.map((c) => c.id)).toEqual([...NOTEBOOK_ICON_CATEGORIES])
    const thin = NOTEBOOK_ICON_CATEGORIES.filter((c) => symbolsInCategory(c).length < 15)
    expect(thin).toEqual([])
    const unknownIcons = NOTEBOOK_ICON_CATEGORIES.filter(
      (c) => !isNotebookSymbol(CATEGORY_ICONS[c]),
    )
    expect(unknownIcons).toEqual([])
    for (const s of NOTEBOOK_SYMBOLS) expect(NOTEBOOK_ICON_CATEGORIES).toContain(s.category)
  })

  it('uses no symbol that depicts an Apple product or is reserved for one', () => {
    const banned = NOTEBOOK_SYMBOLS.filter(({ name }) =>
      BANNED_PREFIXES.some((prefix) => name.startsWith(prefix) || name.includes(`.${prefix}`)),
    )
    expect(banned).toEqual([])
  })

  it('gives lowercase search words', () => {
    for (const s of NOTEBOOK_SYMBOLS) {
      for (const word of s.keywords) expect(word).toMatch(/^[a-z0-9][a-z0-9 ]*$/)
    }
  })

  it('holds the default notebook symbol', () => {
    expect(isNotebookSymbol(DEFAULT_NOTEBOOK_SYMBOL)).toBe(true)
  })

  it('accepts catalog names only', () => {
    expect(isNotebookSymbol('leaf')).toBe(true)
    expect(isNotebookSymbol('iphone')).toBe(false)
    expect(isNotebookSymbol('')).toBe(false)
    expect(isNotebookSymbol(null)).toBe(false)
    expect(isNotebookSymbol('$description')).toBe(false)
  })
})

describe('searchNotebookSymbols', () => {
  const names = (query: string) => searchNotebookSymbols(query).map((s) => s.name)

  it('matches names and keywords, in any case', () => {
    expect(names('Leaf')).toEqual(expect.arrayContaining(['leaf', 'leaf.fill']))
    // `coffee` is a keyword of the mug, not part of its name.
    expect(names('COFFEE')).toEqual(expect.arrayContaining(['mug', 'cup.and.saucer']))
  })

  it('reads the dots of a name as spaces, and needs every word', () => {
    expect(names('cloud rain')).toEqual(['cloud.rain'])
    expect(names('cloud.rain')).toEqual(['cloud.rain'])
  })

  it('keeps catalog order', () => {
    const found = searchNotebookSymbols('heart')
    const order = NOTEBOOK_SYMBOLS.filter((s) => found.includes(s))
    expect(found).toEqual(order)
  })

  it('finds nothing for an empty query or one no symbol matches', () => {
    expect(names('')).toEqual([])
    expect(names('   ')).toEqual([])
    expect(names('zzzz')).toEqual([])
  })
})
