import * as lucide from 'lucide-react'
import { describe, expect, it } from 'vitest'
import catalog from '../../../../design/icons/notebook-lucide.json'
import { NOTEBOOK_LUCIDE_GLYPHS } from './lucideNotebook'
import { ICONS } from './symbols'
import { LUCIDE_FILLS, LUCIDE_ICONS } from './lucide'

describe('the Lucide icon set', () => {
  it('maps exactly the icons that symbols.json names', () => {
    expect(Object.keys(LUCIDE_ICONS).sort()).toEqual([...ICONS].sort())
  })

  it('fills only icons that exist', () => {
    for (const name of Object.keys(LUCIDE_FILLS)) expect(ICONS).toContain(name)
  })
})

const exportName = (glyph: string) =>
  `${glyph
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')}Icon`

describe('the Lucide notebook catalog', () => {
  const names = Object.keys(catalog.symbols)

  it('names only icons lucide-react has, each drawn by its own glyph', () => {
    const exports = lucide as unknown as Record<string, unknown>
    expect(names.filter((name) => exports[exportName(name)] === undefined)).toEqual([])
    expect(Object.keys(NOTEBOOK_LUCIDE_GLYPHS).sort()).toEqual([...names].sort())
    for (const name of names) expect(NOTEBOOK_LUCIDE_GLYPHS[name]).toBe(exports[exportName(name)])
    expect(new Set(Object.values(NOTEBOOK_LUCIDE_GLYPHS)).size).toBe(names.length)
  })

  it('holds the categories\u0027 glyphs and no brand mark', () => {
    for (const { icon } of catalog.categories) expect(names).toContain(icon)
    const brands =
      /^(chrome|github|gitlab|figma|slack|twitter|facebook|instagram|linkedin|youtube|twitch|dribbble|framer|codepen|codesandbox|trello|pocket)/
    expect(names.filter((name) => brands.test(name))).toEqual([])
  })
})
