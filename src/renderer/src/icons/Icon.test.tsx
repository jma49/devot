import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ style: 'sfSymbols' }))
vi.mock('../editorSettings', () => ({
  useEditorSetting: () => state.style,
  editorSettings: () => ({ iconStyle: state.style }),
}))
vi.mock('../ipc', () => ({ invoke: vi.fn<() => Promise<string>>() }))

import { Icon, iconElement } from './Icon'
import { lucideStroke } from './lucide'

describe('Icon', () => {
  beforeEach(() => {
    state.style = 'sfSymbols'
  })

  it('draws an SF Symbol through the mask by default', () => {
    const html = renderToStaticMarkup(<Icon name="trash" size="md" />)
    expect(html).toContain('data-symbol="trash"')
    expect(html).not.toContain('<svg')
  })

  it('draws an SVG in the Lucide style, at the same size class', () => {
    state.style = 'lucide'
    const html = renderToStaticMarkup(<Icon name="trash" size="md" />)
    expect(html).toContain('<svg')
    expect(html).toContain('icon-md')
    expect(html).toContain('stroke="currentColor"')
    expect(html).not.toContain('data-symbol')
  })

  it('keeps the filled pin apart from the outline pin in the Lucide style', () => {
    state.style = 'lucide'
    expect(renderToStaticMarkup(<Icon name="note.pinned" size="sm" />)).toContain('icon-fill-solid')
    expect(renderToStaticMarkup(<Icon name="notes.pinned" size="sm" />)).not.toContain('icon-fill')
    expect(renderToStaticMarkup(<Icon name="status.active" size="sm" />)).toContain(
      'icon-fill-tint',
    )
  })

  it('draws a thin weight with a thin Lucide stroke', () => {
    state.style = 'lucide'
    expect(renderToStaticMarkup(<Icon name="trash" size="toolbar" weight="thin" />)).toContain(
      `stroke-width="${lucideStroke('thin')}"`,
    )
  })
})

describe('lucideStroke', () => {
  it('thickens with the weight', () => {
    expect(lucideStroke()).toBe(2)
    expect(lucideStroke('ultralight')).toBeLessThan(lucideStroke('thin'))
    expect(lucideStroke('thin')).toBeLessThan(lucideStroke('regular'))
    expect(lucideStroke('regular')).toBeLessThan(lucideStroke('bold'))
  })
})

describe('iconElement', () => {
  const fake = () => {
    const el = {
      className: '',
      innerHTML: '',
      dataset: {} as Record<string, string>,
    }
    return Object.assign(el, {
      setAttribute: vi.fn<() => void>(),
      style: { setProperty: vi.fn<() => void>() },
    })
  }

  beforeEach(() => {
    vi.stubGlobal('document', { createElement: fake, documentElement: { dataset: {} } })
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    return () => void vi.unstubAllGlobals()
  })

  it('holds an SVG in the Lucide style, without mounting a React root', () => {
    state.style = 'lucide'
    const el = iconElement('trash', 16) as unknown as ReturnType<typeof fake>
    expect(el.innerHTML).toContain('<svg')
    expect(el.innerHTML).toContain('width="16"')
    expect(el.dataset['symbol']).toBeUndefined()
  })

  it('keeps the SF Symbol span otherwise', () => {
    state.style = 'sfSymbols'
    const el = iconElement('trash', 16) as unknown as ReturnType<typeof fake>
    expect(el.innerHTML).toBe('')
    expect(el.dataset['symbol']).toBe('trash')
  })
})
