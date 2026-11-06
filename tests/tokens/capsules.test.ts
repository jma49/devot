import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { sizes } from '../../src/renderer/src/theme/tokens'

type Path = keyof typeof sizes
function px(path: Path): number {
  const value = Number.parseFloat(sizes[path])
  if (!Number.isFinite(value)) throw new Error(`E_TOKEN_NOT_A_LENGTH ${path}`)
  return value
}

interface Capsule {
  name: string
  height: Path
  edge?: Path
  gap?: Path
  /** End inset token -> the item it holds (its box or round fill). */
  ends: [inset: Path, item: Path][]
}

// design/layout.md, Capsules.
const CAPSULES: Capsule[] = [
  {
    name: 'note pill',
    height: 'size.note-pill',
    gap: 'size.note-pill-gap',
    ends: [
      ['size.note-pill-end-dot', 'space.4'],
      ['size.note-pill-end-xs', 'space.5'],
      ['size.note-pill-end-sm', 'size.icon-sm'],
      ['size.note-pill-end-remove', 'size.note-pill-remove'],
    ],
  },
  {
    name: 'sidebar footer',
    height: 'size.sidebar-footer',
    edge: 'size.capsule-edge',
    gap: 'size.sidebar-footer-gap',
    ends: [
      ['size.sidebar-footer-end-dot', 'space.4'],
      ['size.sidebar-footer-end-sm', 'size.icon-sm'],
    ],
  },
  {
    name: 'sort chip',
    height: 'size.list-filter-control',
    edge: 'size.capsule-edge',
    gap: 'size.list-filter-control-gap',
    ends: [['size.list-filter-control-end-xs', 'space.5']],
  },
  {
    name: 'note row tag chip',
    height: 'size.row-chip',
    edge: 'size.capsule-edge',
    gap: 'size.row-chip-gap',
    ends: [['size.row-chip-end-dot', 'space.4']],
  },
  {
    name: 'toolbar capsule and 32 px field',
    height: 'size.toolbar-control',
    gap: 'size.toolbar-control-gap',
    ends: [
      ['size.toolbar-control-end-sm', 'size.icon-sm'],
      ['size.toolbar-control-end-toolbar', 'size.icon-toolbar'],
    ],
  },
  {
    name: 'palette field',
    height: 'size.glass-palette-field',
    ends: [['size.glass-palette-field-end-md', 'size.icon-md']],
  },
  {
    name: 'floating bar',
    height: 'size.float-toolbar-height',
    ends: [['size.float-toolbar-end', 'size.float-button']],
  },
]

describe('capsule tokens', () => {
  it.each(
    CAPSULES.flatMap((c) => c.ends.map(([inset, item]) => [c.name, inset, item, c] as const)),
  )('R1: the %s holds %s concentric with its end cap', (_name, inset, item, capsule) => {
    const edge = capsule.edge ? px(capsule.edge) : 0
    expect(px(inset)).toBe((px(capsule.height) - px(item)) / 2 - edge)
  })

  it('R3: has one gap for every capsule of one height', () => {
    const byHeight = new Map<number, Set<number>>()
    for (const c of CAPSULES) {
      if (!c.gap) continue
      const gaps = byHeight.get(px(c.height)) ?? new Set()
      gaps.add(px(c.gap))
      byHeight.set(px(c.height), gaps)
    }
    expect(byHeight.get(20)?.size).toBe(1)
    for (const gaps of byHeight.values()) expect(gaps.size).toBe(1)
  })

  it('reserves a removable pill end for the x, one gap clear of the label', () => {
    expect(px('size.note-pill-trail')).toBe(
      px('size.note-pill-end-xs') + px('space.5') + px('size.note-pill-gap'),
    )
    expect(px('size.note-pill-remove')).toBeGreaterThanOrEqual(16)
    // The x button's box is concentric with the glyph box it centres.
    expect(px('size.note-pill-end-remove') + px('size.note-pill-remove') / 2).toBe(
      px('size.note-pill-end-xs') + px('space.5') / 2,
    )
  })

  it('makes a floating bar a capsule', () => {
    expect(px('radius.glass-floating-bar')).toBe(px('size.float-toolbar-height') / 2)
  })

  it('sizes a row chip to its caption line and its border', () => {
    expect(px('size.row-chip')).toBe(px('font.size.caption2') * 1.5 + 2 * px('size.capsule-edge'))
  })

  it('names every capsule token in design/layout.md', () => {
    const layout = readFileSync('design/layout.md', 'utf8')
    const named = CAPSULES.flatMap((c) => [c.gap, ...c.ends.map(([inset]) => inset)])
    for (const path of named.filter((p) => p?.startsWith('size.'))) {
      expect(layout).toContain(`\`${path}\``)
    }
  })
})
