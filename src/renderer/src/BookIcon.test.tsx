import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ style: 'lucide' }))
vi.mock('./editorSettings', () => ({
  useEditorSetting: () => state.style,
  editorSettings: () => ({ iconStyle: state.style }),
}))
vi.mock('./ipc', () => ({ invoke: vi.fn<() => Promise<string>>() }))

import { BookIcon } from './BookIcon'

describe('BookIcon', () => {
  beforeEach(() => {
    state.style = 'lucide'
  })

  it('draws the default notebook icon as an SVG in the Lucide style', () => {
    const html = renderToStaticMarkup(<BookIcon icon={null} color={null} size="md" />)
    expect(html).toContain('<svg')
    expect(html).toContain('book-icon')
  })

  it('keeps a chosen icon an SF Symbol in the Lucide style', () => {
    const html = renderToStaticMarkup(<BookIcon icon="star" color={null} size="md" />)
    expect(html).toContain('data-symbol="star"')
    expect(html).not.toContain('<svg')
  })

  it('keeps a Lucide icon in Lucide in the SF style, painting nothing until its glyphs are in', () => {
    state.style = 'sfSymbols'
    const pending = renderToStaticMarkup(<BookIcon icon="lucide:leaf" color="green" size="md" />)
    expect(pending).toContain('data-lucide="leaf"')
    expect(pending).toContain('data-pending')
    expect(pending).toContain('tag-color-green')
    expect(pending).not.toContain('data-symbol')
  })

  it('sizes a Lucide icon for a phone row like any other', () => {
    const html = renderToStaticMarkup(<BookIcon icon="lucide:leaf" color={null} size="phone-row" />)
    expect(html).toContain('icon-phone-row')
    expect(html).not.toContain('data-symbol')
  })

  it('draws the default icon as an SF Symbol in the SF style', () => {
    state.style = 'sfSymbols'
    const html = renderToStaticMarkup(<BookIcon icon={null} color={null} size="md" />)
    expect(html).toContain('data-symbol=')
    expect(html).not.toContain('<svg')
  })
})
