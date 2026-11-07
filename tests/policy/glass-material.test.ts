import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { listFiles } from '../support/git-files'
import { cssRules } from '../support/css-rules'

// One glass material (design/README.md, Glass interface): every surface that floats over the
// sheet paints `--glass-material-bg`, and nothing paints a second glass fill.

const css = readFileSync('src/renderer/src/app.css', 'utf8')
const REDUCE = '@media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {'
const reduceAt = css.indexOf(REDUCE)
const reduceEnd = css.indexOf('\n}\n', reduceAt)
const rules = cssRules(css.slice(0, reduceAt) + css.slice(reduceEnd + 2))
const reduceRules = cssRules(css.slice(reduceAt + REDUCE.length, reduceEnd))
const body = rules.find((r) => r.selector === 'body' && r.body.has('--glass-sheet'))!

/** The selectors a rule lists, an `:is()` list read as its members. */
const listed = (selector: string) => {
  const is = /^:is\(([^()]*)\)$/.exec(selector)
  const list = is ? is[1]! : selector
  const members: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '(') depth++
    else if (list[i] === ')') depth--
    else if (list[i] === ',' && depth === 0) {
      members.push(list.slice(from, i))
      from = i + 1
    }
  }
  return [...members, list.slice(from)].map((s) => s.trim())
}

/** The background the last rule naming exactly `selector` paints. */
const background = (selector: string) =>
  rules
    .filter((r) => listed(r.selector).includes(selector) && r.body.has('background'))
    .at(-1)
    ?.body.get('background')

const GLASS = [
  '.sidebar',
  '.settings-nav',
  '.toolbar .tool',
  '.toolbar .segmented',
  '.settings-history',
  '.tool-tip',
  '.palette',
  '.picker-popover',
  '.tag-suggestions',
  '.more-menu-list',
  '.note-info-card',
  '.date-picker',
  '.history-handle-date',
  '.drag-card',
  '.sheet',
  '.confirm',
  '.link-dialog',
  '.search-help',
  '.plugin-panel',
]

describe('the glass material', () => {
  it('is the material token, its own slider, the theme gradient and a top sheen', () => {
    expect(body.body.get('--glass-material')).toBe(
      'color( from var(--color-surface-glass) srgb r g b / clamp(0, 1 - (1 - alpha) * (1 + var(--material-transparency, 0) / 100), 1) )',
    )
    expect(body.body.get('--glass-sheen')).toBe(
      'linear-gradient( var(--color-surface-glass-sheen), transparent var(--size-glass-sheen) )',
    )
    expect(body.body.get('--glass-tint')).toBe('var(--backdrop, none) fixed, var(--glass-material)')
    expect(body.body.get('--glass-material-bg')).toBe('var(--glass-sheen), var(--glass-tint)')
    // Glass Transparency keeps only the sheet.
    expect(body.body.get('--glass-sheet')).toContain('var(--window-transparency, 0)')
    expect(body.body.get('--glass-material')).not.toContain('window-transparency')
  })

  it.each(GLASS)('paints %s', (selector) => {
    expect(background(selector)).toBe('var(--glass-material-bg)')
  })

  it('lays the drag image card fill over the material, with no window-aligned gradient off screen', () => {
    expect(background('.drag-card-holder > .card.drag-card-copy')).toBe(
      'linear-gradient(var(--color-fill-card), var(--color-fill-card)), var(--glass-sheen), var(--glass-material)',
    )
  })

  it('fills the notches with the material, the sheen only where they meet a top edge', () => {
    for (const up of [".tool-tip[data-side='below']", ".picker-popover:not([data-side='above'])"]) {
      expect(background(`${up}::after`)).toBe('var(--glass-sheen-top), var(--glass-tint)')
      expect(background(`${up}::before`)).toBe('var(--color-line-glass-edge)')
    }
    for (const down of [
      ".tool-tip:not([data-side='below'])",
      ".picker-popover[data-side='above']",
    ]) {
      expect(background(`${down}::after`)).toBe('var(--glass-tint)')
      expect(background(`${down}::before`)).toBe('var(--color-line-glass-edge)')
    }
  })

  it('stops the top highlight either side of a notch on the top edge', () => {
    expect(body.body.get('--glass-rim-highlight')).toBe(
      'inset 0 1px 0 var(--color-line-glass-highlight)',
    )
    expect(body.body.get('--glass-rim')).toBe('var(--glass-rim-highlight), var(--glass-rim-edge)')
    for (const up of [
      ".tool-tip.note-card-pop[data-side='below']",
      ".picker-popover:not([data-side='above'])",
    ]) {
      const rule = rules.find((r) => listed(r.selector).includes(up))
      expect(rule?.body.get('box-shadow')).toBe('var(--glass-rim-edge), var(--popover-shadow)')
      expect(rule?.body.get('background')).toBe(
        'var(--glass-highlight) left top / max(0px, var(--notch-x) - var(--notch-width) / 2) 1px no-repeat, ' +
          'var(--glass-highlight) right top / max(0px, 100% - var(--notch-x) - var(--notch-width) / 2) 1px no-repeat, ' +
          'var(--glass-material-bg)',
      )
    }
  })

  // A transform puts a fixed background in the element's own coordinates, so the theme gradient
  // would no longer line up with the window. A Z translation alone moves nothing.
  it('turns and shifts no surface that paints the material', () => {
    const base = (selector: string) =>
      selector.replace(/:not\((?:[^()]|\([^()]*\))*\)|\[[^\]]*\]/g, '').trim()
    const glass = new Set(
      rules
        .filter((r) => /--glass-(tint|material-bg)/.test(r.body.get('background') ?? ''))
        .flatMap((r) => listed(r.selector).map(base)),
    )
    const moved = rules.filter(
      (r) =>
        listed(r.selector).some((s) => glass.has(base(s))) &&
        (r.body.has('rotate') ||
          /rotate|skew|matrix|translate(X|Y|3d)?\(/.test(r.body.get('transform') ?? '')),
    )
    expect(moved.map((r) => r.selector)).toEqual([])
  })

  it('rims every glass surface with the glass edge, not a hairline', () => {
    const floating = rules.find((r) => r.selector.startsWith(':is( .tool-tip, .palette'))
    expect(floating?.body.get('box-shadow')).toBe('var(--glass-rim), var(--popover-shadow)')
    for (const selector of ['.history-handle-date'])
      expect(
        rules
          .filter((r) => r.selector === selector)
          .at(-1)
          ?.body.get('box-shadow'),
      ).toBe('var(--glass-rim)')
    expect(rules.find((r) => r.selector === '.search-help')?.body.get('border')).toBe('0')
  })

  it('puts no glass on glass: controls inside it are washes', () => {
    expect(background('.footer-toggle:not(:hover, :active)')).toBe('var(--color-fill-track)')
    expect(background('.footer-toggle:hover')).toBe('var(--color-fill-tool-hover)')
    expect(background('.palette-field')).toBe('var(--color-fill-track)')
    expect(background('.palette-field:hover')).toBe('var(--color-fill-tool-hover)')
    expect(background('.settings-search')).toBe('var(--color-fill-track)')
    expect(background('.settings-search:hover')).toBe('var(--color-fill-tool-hover)')
  })

  it('selects a view mode segment with the selected-row wash, the rim and a small shadow', () => {
    const on = rules.find((r) => r.selector === ".toolbar .segment[aria-pressed='true']")
    expect(on?.body.get('background')).toBe('var(--color-fill-row-selected)')
    expect(on?.body.get('box-shadow')).toBe(
      'var(--glass-rim), 0 1px var(--space-2) var(--color-shadow-glass)',
    )
  })

  it('highlights a menu row with the accent wash', () => {
    expect(body.body.get('--menu-highlight')).toBe(
      'color-mix( in srgb, var(--color-accent-fill) calc(var(--opacity-list-selected) * 100%), transparent )',
    )
  })

  it('falls back to opaque surfaces, with no sheen or gradient, under Reduce Transparency', () => {
    const fallback = reduceRules.find((r) => r.selector === 'body')!
    expect(fallback.body.get('--glass-material-bg')).toBe('var(--color-surface-editor)')
    expect(fallback.body.get('--glass-tint')).toBe('var(--color-surface-editor)')
    expect(fallback.body.get('--glass-sheen')).toBe('none')
    expect(fallback.body.get('--glass-sheen-top')).toBe('none')
    const sidebar = reduceRules.find((r) => r.selector === ':is(.sidebar, .settings-nav)')
    expect(sidebar?.body.get('background')).toBe('var(--color-surface-sidebar-opaque)')
  })
})

describe('the editor popups', () => {
  const sources = {
    completions: 'src/renderer/src/editor/completions.ts',
    floating: 'src/renderer/src/editor/floating.tsx',
    notch: 'src/renderer/src/editor/notch.ts',
    noteLinkHover: 'src/renderer/src/editor/noteLinkHover.ts',
    authorship: 'src/renderer/src/editor/authorship.ts',
    linkCompletion: 'src/renderer/src/linkCompletion.ts',
  }
  const source = (name: keyof typeof sources) => readFileSync(sources[name], 'utf8')

  it.each(['completions', 'floating', 'noteLinkHover', 'authorship', 'linkCompletion'] as const)(
    '%s paints the material with the glass rim',
    (name) => {
      expect(source(name)).toContain("background: 'var(--glass-material-bg)'")
      expect(source(name)).toContain('var(--glass-rim)')
      expect(source(name)).not.toContain('--color-line-hairline), var(--popover-shadow)')
    },
  )

  it('highlights the selected completion and the paste preview with the accent wash', () => {
    expect(source('completions')).toContain("backgroundColor: 'var(--menu-highlight)'")
    expect(readFileSync('src/renderer/src/editor/pasteChooser.ts', 'utf8')).toContain(
      "backgroundColor: 'var(--menu-highlight)'",
    )
  })

  it('edges the floating bar notch with the glass edge and fills it with the material', () => {
    expect(source('notch')).toContain("'var(--color-line-glass-edge)'")
    expect(source('notch')).toContain("'var(--glass-tint)'")
  })

  it.each(['floating', 'notch'] as const)('%s turns and shifts none of its glass', (name) => {
    expect(source(name)).not.toMatch(/\b(transform|rotate|translate)\s*:/)
  })
})

it('names no removed glass token anywhere in the app', () => {
  const removed =
    /--color-(fill-glass-control|surface-glass-popover|surface-glass-float-bar|line-float-bar|fill-completion-selected)\b|--glass-sidebar\b/
  const files = listFiles('.', 'src').filter((f) => /\.(css|ts|tsx)$/.test(f))
  expect(files.filter((f) => removed.test(readFileSync(f, 'utf8')))).toEqual([])
})

it('paints nothing with the popover and float bar surfaces, kept only for contrast checks', () => {
  const files = listFiles('.', 'src').filter((f) => /\.(css|ts|tsx)$/.test(f))
  expect(
    files.filter((f) => /var\(--color-surface-(popover|float-bar)\)/.test(readFileSync(f, 'utf8'))),
  ).toEqual([])
})
