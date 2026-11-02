import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import symbolsJson from '../../design/icons/symbols.json'
import { dark, ivoryDark, ivoryLight, light, sizes } from '../../src/renderer/src/theme/tokens'

const px = (token: keyof typeof sizes): number => Number.parseFloat(sizes[token])

describe('the phone layout tokens', () => {
  it.each([
    ['size.phone-nav-control', 44],
    ['size.phone-glass-bar', 64],
    ['size.phone-lens-inset', 4],
    ['size.phone-editor-toolbar', 48],
    ['size.phone-list-row', 76],
    ['size.phone-avatar', 60],
    ['size.phone-grouped-row', 44],
    ['size.phone-row-tile', 30],
    ['size.phone-swipe-action', 50],
    ['size.phone-swipe-open', 190],
    ['size.phone-swipe-arm', 280],
    ['size.phone-grabber-width', 36],
    ['size.phone-grabber-height', 5],
    ['size.phone-screen-edge', 16],
    ['size.phone-list-edge', 20],
    ['size.phone-list-text', 52],
    ['size.phone-card-inset', 4],
    ['size.phone-row-pad', 12],
    ['size.phone-group-title', 10],
    ['size.phone-topbar-top', 12],
    ['size.phone-topbar-band', 68],
    ['size.phone-content-top', 80],
    ['size.phone-capsule-button', 48],
    ['size.phone-tab-inset', 20],
    ['size.phone-tab-bottom', 24],
    ['radius.phone-card', 22],
    ['radius.phone-row-press', 16],
    ['radius.phone-sheet', 34],
    ['radius.phone-tile-card', 22],
    ['radius.phone-row-tile', 8],
    ['radius.phone-menu-row', 16],
  ] as const)('%s is %i', (token, value) => {
    expect(px(token)).toBe(value)
  })

  it('puts a grouped row 32 from the screen and a group title 26', () => {
    const card = px('size.phone-screen-edge')
    expect(card + px('size.phone-card-inset') + px('size.phone-row-pad')).toBe(32)
    expect(card + px('size.phone-group-title')).toBe(26)
  })

  it('keeps content clear of the band', () => {
    expect(px('size.phone-topbar-top') + px('size.phone-nav-control')).toBeLessThan(
      px('size.phone-topbar-band'),
    )
    expect(px('size.phone-content-top')).toBeGreaterThan(px('size.phone-topbar-band'))
  })

  it('keeps every lens concentric with its bar', () => {
    const inset = px('size.phone-lens-inset')
    expect(px('size.phone-glass-bar') / 2 - inset).toBe(px('radius.phone-lens-bar'))
    expect(px('size.phone-segmented') / 2 - inset).toBe(px('radius.phone-lens-segmented'))
  })

  it('keeps what sits in a sheet concentric with the sheet', () => {
    const sheet = px('radius.phone-sheet')
    expect(sheet - px('size.phone-sheet-pad')).toBe(px('radius.phone-sheet-card'))
    expect(sheet - px('size.phone-capture-pad')).toBe(px('radius.phone-capture-field'))
  })

  it('gives every tappable control a target of at least 44 points', () => {
    for (const token of [
      'size.phone-target',
      'size.phone-nav-control',
      'size.phone-segmented',
      'size.phone-editor-toolbar',
      'size.phone-grouped-row',
      'size.phone-swipe-action',
    ] as const) {
      expect(px(token)).toBeGreaterThanOrEqual(44)
    }
  })
})

describe('the phone motion tokens', () => {
  it('holds the three curves of the motion spec', () => {
    expect(sizes['motion.easing.phone-push']).toBe('cubic-bezier(0.23, 1, 0.32, 1)')
    expect(sizes['motion.duration.phone-push']).toBe('500ms')
    expect(sizes['motion.spring.gentle-damping']).toBe('0.75')
    expect(sizes['motion.spring.gentle-response']).toBe('0.36')
    expect(sizes['motion.spring.bouncy-damping']).toBe('0.62')
    expect(sizes['motion.spring.bouncy-response']).toBe('0.42')
  })
})

describe('the phone colour tokens', () => {
  it.each([
    ['light', light],
    ['dark', dark],
    ['ivory light', ivoryLight],
    ['ivory dark', ivoryDark],
  ] as const)('%s has an opaque glass fallback for Reduce Transparency', (_name, theme) => {
    expect(theme['color.phone.glass-opaque']).toMatch(/^#[0-9a-f]{6}$/)
    expect(theme['color.phone.background']).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('takes the design colours of the system theme', () => {
    expect(light['color.phone.background']).toBe('#fafafa')
    expect(light['color.phone.card']).toBe('#f0f0f2')
    expect(light['color.phone.text']).toBe('#111111')
    expect(dark['color.phone.background']).toBe('#000000')
    expect(dark['color.phone.card']).toBe('#1c1c1e')
    expect(dark['color.phone.text']).toBe('#f5f5f7')
  })
})

describe('the phone symbols', () => {
  it('pairs each tab icon with its filled symbol', () => {
    const symbols: Record<string, string> = symbolsJson.symbols
    for (const tab of ['notes', 'library', 'settings']) {
      expect(symbols[`phone.tab.${tab}.fill`]).toBe(`${symbols[`phone.tab.${tab}`]}.fill`)
    }
  })

  it('specifies Dynamic Type', () => {
    expect(readFileSync('design/phone.md', 'utf8')).toContain('--phone-text-scale')
  })

  it('records the spec beside the other design rules', () => {
    expect(readFileSync('design/README.md', 'utf8')).toContain('[phone.md](phone.md)')
  })
})
