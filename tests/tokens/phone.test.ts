import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import symbolsJson from '../../design/icons/symbols.json'
import { dark, ivoryDark, ivoryLight, light, sizes } from '../../src/renderer/src/theme/tokens'

const px = (token: keyof typeof sizes): number => Number.parseFloat(sizes[token])

describe('the phone layout tokens', () => {
  it.each([
    ['size.phone-nav-control', 44],
    ['size.phone-glass-bar', 62],
    ['size.phone-lens-inset', 4],
    ['size.phone-editor-toolbar', 48],
    ['size.phone-list-row', 62],
    ['size.phone-grouped-row', 44],
    ['size.phone-row-icon', 28],
    ['size.icon-phone-row', 21],
    ['size.icon-phone-status', 20],
    ['size.phone-swipe-action', 52],
    ['size.phone-swipe-action-height', 34],
    ['size.phone-swipe-surface-inset', 3],
    ['size.phone-section-head', 40],
    ['size.phone-show-more', 52],
    ['radius.phone-swipe-surface', 20],
    ['radius.phone-peek', 26],
    ['size.phone-swipe-open', 196],
    ['size.phone-swipe-arm', 270],
    ['size.phone-grabber-width', 36],
    ['size.phone-grabber-height', 5],
    ['size.phone-screen-edge', 16],
    ['size.phone-list-edge', 20],
    ['size.phone-list-text', 52],
    ['size.phone-card-inset', 4],
    ['size.phone-row-pad', 12],
    ['size.phone-group-gap', 20],
    ['size.phone-stepper-height', 32],
    ['size.phone-stepper-button', 44],
    ['size.phone-theme-thumb-width', 44],
    ['size.phone-theme-thumb-height', 56],
    ['size.phone-group-title', 10],
    ['size.phone-topbar-top', 12],
    ['size.phone-topbar-band', 68],
    ['size.phone-content-top', 80],
    ['size.phone-capsule-button', 48],
    ['size.phone-tab-inset', 16],
    ['size.phone-compose', 62],
    ['size.phone-compose-gap', 10],
    ['size.phone-capture-height', 440],
    ['size.phone-arrive-rise', 320],
    ['size.phone-tab-bottom', 24],
    ['size.phone-search-chip', 34],
    ['size.phone-child-indent', 40],
    ['size.phone-search-empty', 56],
    ['size.phone-heat-cell', 16],
    ['size.phone-heat-gap', 4],
    ['size.phone-heat-legend', 11],
    ['radius.phone-heat-cell', 4],
    ['radius.phone-heat-legend', 3],
    ['radius.phone-card', 22],
    ['radius.phone-row-press', 16],
    ['radius.phone-theme-thumb', 10],
    ['radius.phone-sheet', 34],
    ['radius.phone-menu-row', 20],
  ] as const)('%s is %i', (token, value) => {
    expect(px(token)).toBe(value)
  })

  it('fits the tab bar and the compose circle on a 390 screen', () => {
    const inset = px('size.phone-tab-inset')
    const compose = px('size.phone-compose')
    expect(390 - inset * 2 - compose - px('size.phone-compose-gap')).toBe(286)
    expect(390 - inset - compose).toBe(312)
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

  it('adds the capsules up to the open width', () => {
    expect(
      px('size.phone-swipe-action') * 3 +
        px('size.phone-swipe-gap') * 2 +
        px('size.phone-swipe-inset') * 2,
    ).toBe(px('size.phone-swipe-open'))
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
  it('moves the lens on the platform default spring, and takes 560 ms over capture', () => {
    expect(sizes['motion.spring.phone-lens-trail-damping']).toBe('1')
    expect(sizes['motion.spring.phone-lens-trail-response']).toBe('0.5')
    expect(Number(sizes['motion.spring.phone-lens-lead-response'])).toBeLessThan(0.5)
    expect(Number(sizes['motion.scale.phone-lens-lift'])).toBe(1.08)
    expect(sizes['motion.duration.phone-capture']).toBe('560ms')
    expect(Number(sizes['motion.scale.phone-arrive'])).toBe(0.92)
  })

  it('draws the glass rim from tokens, on the bars and the lifted lens', () => {
    expect(px('shadow.phone-glass-rim-offset')).toBe(1.5)
    expect(px('shadow.phone-glass-rim-blur')).toBe(1)
    expect(px('shadow.phone-glass-rim-spread')).toBe(-1)
    const css = readFileSync('src/renderer/src/phone/phone.css', 'utf8')
    const shadows = [...css.matchAll(/box-shadow:([^;]*);/g)].map((match) => match[1]!)
    const rims = shadows.filter((shadow) => shadow.includes('--color-phone-glass-highlight'))
    expect(rims.length).toBeGreaterThanOrEqual(2)
    for (const rim of rims) {
      const highlight = rim.split(',').find((layer) => layer.includes('glass-highlight'))!
      expect(highlight).not.toMatch(/\d(px|pt)\b/)
      expect(highlight).toContain('var(--shadow-phone-glass-rim-offset)')
    }
  })

  it('keeps the toast 4 s and rising 100 above the bottom', () => {
    expect(sizes['motion.duration.phone-toast']).toBe('4000ms')
    expect(Number(sizes['motion.scale.phone-toast'])).toBe(0.9)
    expect(px('size.phone-toast-bottom')).toBe(100)
    expect(px('size.phone-toast')).toBe(48)
  })

  it('dims a peek and a push as the spec does', () => {
    expect(Number(sizes['opacity.phone-dim-peek'])).toBe(0.18)
    expect(Number(sizes['opacity.phone-dim-push'])).toBe(0.08)
    expect(Number(sizes['motion.scale.phone-peek-enter'])).toBe(0.86)
    expect(sizes['motion.delay.phone-peek-bar']).toBe('90ms')
    expect(sizes['motion.delay.phone-peek-menu']).toBe('50ms')
  })

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

  it('takes the glass of the design in the system theme', () => {
    expect(light['color.phone.glass']).toBe('rgb(255 255 255 / 0.4)')
    expect(dark['color.phone.glass']).toBe('rgb(40 40 44 / 0.32)')
    expect(light['color.phone.glass-sheen']).toBe('rgb(255 255 255 / 0.55)')
    expect(dark['color.phone.glass-rim-a']).toBe('rgb(255 255 255 / 0.38)')
    expect(sizes['motion.duration.phone-glass-press']).toBe('320ms')
    expect(px('size.phone-glass-rim')).toBe(1.2)
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
    for (const tab of ['notes', 'library', 'activity', 'settings']) {
      expect(symbols[`phone.tab.${tab}.fill`]).toBe(`${symbols[`phone.tab.${tab}`]}.fill`)
    }
  })

  it('draws the five status marks as line symbols', () => {
    const symbols: Record<string, string> = symbolsJson.symbols
    expect(symbols['phone.status.active']).toBe('circle')
    expect(symbols['phone.status.onHold']).toBe('pause.circle')
    expect(symbols['phone.status.completed']).toBe('checkmark.circle.fill')
    expect(symbols['phone.status.dropped']).toBe('xmark.circle')
    expect(symbols['phone.status.none']).toBe('circle.dashed')
  })

  it('leaves the Mac its filled status symbols', () => {
    expect(symbolsJson.symbols['status.active']).toBe('play.circle.fill')
    expect(symbolsJson.symbols['status.onHold']).toBe('pause.circle.fill')
    expect(symbolsJson.symbols['status.dropped']).toBe('xmark.circle.fill')
  })

  it('has no tiled symbols or tile tokens left', () => {
    const names = Object.keys(symbolsJson.symbols)
    expect(names.filter((name) => name.startsWith('phone.tile.'))).toEqual([])
    expect(
      Object.keys(sizes).filter((name) => /phone-row-tile|phone-status-ring/.test(name)),
    ).toEqual([])
  })

  it('specifies Dynamic Type', () => {
    expect(readFileSync('design/phone.md', 'utf8')).toContain('--phone-text-scale')
  })

  it('records the spec beside the other design rules', () => {
    expect(readFileSync('design/README.md', 'utf8')).toContain('[phone.md](phone.md)')
  })
})
