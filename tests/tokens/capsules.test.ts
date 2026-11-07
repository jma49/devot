import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { sizes } from '../../src/renderer/src/theme/tokens'
import { cssRules } from '../support/css-rules'

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

const rules = cssRules(readFileSync('src/renderer/src/app.css', 'utf8'))
const glass = (selector: string) => `:root[data-sidebar-material='on'] ${selector}`
const declared = (selector: string, property: string) =>
  rules
    .findLast((r) => r.selector === selector && r.body.has(property))
    ?.body.get(property)
    ?.replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')

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

  it("lets the x cover a removable pill's label end: clear under its glyph, fading over one gap", () => {
    expect(px('size.note-pill-remove-cover')).toBe(
      px('size.note-pill-end-xs') +
        px('space.5') +
        px('size.note-pill-gap') -
        px('size.note-pill-pad'),
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
    const named = [
      ...CAPSULES.flatMap((c) => [c.gap, ...c.ends.map(([inset]) => inset)]),
      'size.note-pill-remove-cover',
    ]
    for (const path of named.filter((p) => p?.startsWith('size.'))) {
      expect(layout).toContain(`\`${path}\``)
    }
  })

  it('places capsule contents with these tokens in the Glass interface', () => {
    const expected: [selector: string, property: string, value: string][] = [
      [glass('.note-meta .chip'), 'gap', 'var(--size-note-pill-gap)'],
      [
        glass('.note-meta .chip:has(> .tag-dot)'),
        'padding-inline-start',
        'var(--size-note-pill-end-dot)',
      ],
      [glass('.note-meta .chip-remove'), 'width', 'var(--size-note-pill-remove)'],
      [glass('.note-meta .chip-remove'), 'inset-inline-end', 'var(--size-note-pill-end-remove)'],
      [glass('.note-meta .chip-remove'), 'inset-block', 'var(--size-note-pill-end-remove)'],
      [glass('.note-meta .chip-remove'), 'height', 'var(--size-note-pill-remove)'],
      [
        glass('.note-meta .popup'),
        'padding-inline',
        'var(--size-note-pill-pad) var(--size-note-pill-end-xs)',
      ],
      [
        glass('.footer-toggle'),
        'padding-inline',
        'var(--space-5) var(--size-sidebar-footer-end-sm)',
      ],
      [
        glass('.palette-field'),
        'padding',
        '0 var(--space-6) 0 var(--size-glass-palette-field-end-md)',
      ],
      [glass('.note-meta .popup'), 'gap', 'var(--size-note-pill-gap)'],
      [
        glass(".note-meta .popup[class*='status-']"),
        'padding-inline-start',
        'var(--size-note-pill-end-xs)',
      ],
      [glass('.note-meta .book-popup'), 'padding-inline-start', 'var(--size-note-pill-end-sm)'],
      [glass('.footer-toggle'), 'column-gap', 'var(--size-sidebar-footer-gap)'],
      [
        glass('.footer-toggle:has(> .footer-dot)'),
        'padding-inline-start',
        'var(--size-sidebar-footer-end-dot)',
      ],
      [glass('.sort-chip'), 'gap', 'var(--size-list-filter-control-gap)'],
      [
        glass('.list-filter .search-icon'),
        'padding-inline',
        'calc(var(--size-list-keyline-inner) - var(--size-list-keyline-outer)) var(--size-toolbar-control-gap)',
      ],
      [glass('.settings-search'), 'padding-inline-start', 'var(--size-toolbar-control-end-sm)'],
      [glass('.settings-search'), 'gap', 'var(--size-toolbar-control-gap)'],
      ['.row .chip', 'gap', 'var(--size-row-chip-gap)'],
      ['.row .chip:has(> .tag-dot)', 'padding-inline-start', 'var(--size-row-chip-end-dot)'],
    ]
    for (const [selector, property, value] of expected) {
      expect(declared(selector, property), `${selector} ${property}`).toBe(value)
    }
  })

  it('keeps a removable tag pill symmetric at rest, the x drawn over the label end', () => {
    const resizes = rules.filter(
      (r) =>
        r.selector.includes('.note-meta .chip') &&
        /:hover|:focus/.test(r.selector) &&
        ['padding', 'padding-inline', 'padding-inline-end', 'width', 'min-width'].some((p) =>
          r.body.has(p),
        ),
    )
    expect(resizes.map((r) => r.selector)).toEqual([])
    expect(declared(glass('.note-meta .chip'), 'padding')).toBe('0 var(--size-note-pill-pad)')
    expect(
      rules.some(
        (r) => r.selector.includes('.chip:has(> .chip-remove)') && r.body.has('padding-inline-end'),
      ),
    ).toBe(false)

    const label = glass('.note-meta .chip-label')
    const shown = glass('.note-meta .chip:is(:hover, :focus-within) > .chip-label')
    expect(declared(shown, '--chip-label-cover')).toBe('var(--size-note-pill-remove-cover)')
    const fade =
      'linear-gradient(to left, transparent calc(var(--chip-label-cover) - var(--size-note-pill-gap)), var(--color-ink-text) var(--chip-label-cover))'
    expect([declared(label, 'mask-image'), declared(label, '-webkit-mask-image')]).toEqual([
      fade,
      fade,
    ])
    expect(declared(glass('.note-meta .chip-label:dir(rtl)'), 'mask-image')).toContain('to right')
  })

  it("reveals the x as a hover fade, and the label's fade at once under Reduce Motion", () => {
    const hover = 'var(--motion-duration-hover) var(--motion-easing-out)'
    expect(declared(glass('.note-meta .chip-remove'), 'transition')).toBe(`opacity ${hover}`)
    expect(declared(glass('.note-meta .chip-label'), 'transition')).toBe(
      `--chip-label-cover ${hover}`,
    )
    expect(
      declared(
        `:root[data-motion='reduced'][data-sidebar-material='on'] .note-meta .chip-label`,
        'transition',
      ),
    ).toBe('none')
  })
})
