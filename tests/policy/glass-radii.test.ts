import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cssRules } from '../support/css-rules'

interface DimensionToken {
  $value: { value: number }
}
const tokens = JSON.parse(readFileSync('design/tokens/base.tokens.json', 'utf8')) as {
  radius: Record<string, DimensionToken>
  size: Record<string, DimensionToken>
}
function dimension(group: Record<string, DimensionToken>, name: string): number {
  const token = group[name]
  if (!token) throw new Error(`missing token ${name}`)
  return token.$value.value
}
const radius = (name: string): number => dimension(tokens.radius, name)
const size = (name: string): number => dimension(tokens.size, name)

describe('Glass radii are concentric: inner radius = outer radius - inset', () => {
  it.each([
    ['window, sidebar', radius('window') - size('sidebar-inset'), radius('sidebar')],
    ['sidebar, row', radius('sidebar') - size('sidebar-row-inset'), radius('sidebar-row')],
    [
      'sidebar, footer capsule',
      radius('sidebar') - size('sidebar-row-inset'),
      size('sidebar-footer') / 2,
    ],
    ['dialog, group', radius('glass-dialog') - size('glass-dialog-inset'), radius('glass-group')],
    [
      'popover, menu row',
      radius('glass-popover') - size('glass-popover-inset'),
      radius('glass-menu-row'),
    ],
    [
      'dialog, button capsule',
      radius('glass-dialog') - size('glass-dialog-inset'),
      size('glass-dialog-button') / 2,
    ],
    [
      'palette, field capsule',
      radius('glass-dialog') - size('glass-palette-inset'),
      size('glass-palette-field') / 2,
    ],
  ])('%s', (_pair, computed, documented) => {
    expect(computed).toBe(documented)
  })

  it('keeps the documented values', () => {
    expect(radius('window')).toBe(26)
    expect(radius('glass-dialog')).toBe(26)
    expect(radius('glass-popover')).toBe(18)
    expect(radius('glass-tooltip')).toBe(12)
    expect(radius('sidebar')).toBe(18)
  })

  it('insets the sidebar rows by the same amount the row radius assumes', () => {
    const rules = cssRules(readFileSync('src/renderer/src/app.css', 'utf8'))
    const sidebar = rules.find((r) => r.selector === ":root[data-sidebar-material='on'] .sidebar")
    expect(sidebar?.body.get('padding-inline')).toBe('var(--size-sidebar-row-inset)')
    expect(sidebar?.body.get('padding-block-end')).toBe('var(--size-sidebar-row-inset)')
    const nav = rules.find((r) => r.selector === ":root[data-sidebar-material='on'] .settings-nav")
    expect(nav?.body.get('padding')).toMatch(/var\(--size-sidebar-row-inset\)$/)
  })

  it('asks macOS for the window corner the tokens assume', () => {
    const native = readFileSync('src-tauri/src/native/macos.rs', 'utf8')
    const corner = /const WINDOW_CORNER_RADIUS: f64 = ([\d.]+);/.exec(native)?.[1]
    expect(Number(corner)).toBe(radius('window'))
  })

  it('keeps the sidebar footer a capsule', () => {
    const rules = cssRules(readFileSync('src/renderer/src/app.css', 'utf8'))
    const footer = rules.find(
      (r) => r.selector === ":root[data-sidebar-material='on'] .footer-toggle",
    )
    expect(footer?.body.get('border-radius')).toBe('var(--radius-capsule)')
  })

  it('sets toolbar controls as far from the right edge as from the top', () => {
    const rules = cssRules(readFileSync('src/renderer/src/app.css', 'utf8'))
    const bars = rules.find(
      (r) =>
        r.selector === ":root[data-sidebar-material='on'] :is(.editor-toolbar, .settings-toolbar)",
    )
    expect(bars?.body.get('padding-inline-end')).toBe(
      'calc((var(--size-toolbar-height) - var(--size-toolbar-control)) / 2)',
    )
  })
})
