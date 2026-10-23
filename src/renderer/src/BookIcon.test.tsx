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

  it('draws the default icon as an SF Symbol in the SF style', () => {
    state.style = 'sfSymbols'
    const html = renderToStaticMarkup(<BookIcon icon={null} color={null} size="md" />)
    expect(html).toContain('data-symbol=')
    expect(html).not.toContain('<svg')
  })
})
