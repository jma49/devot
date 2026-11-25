// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import catalog from '../../../../design/icons/kubai.json'
import { KUBAI_GLYPHS } from './kubaiGlyphs'
import { ICONS } from './symbols'

vi.mock('../editorSettings', () => ({
  useEditorSetting: () => 'kubai',
  editorSettings: () => ({ iconStyle: 'kubai' }),
}))
vi.mock('../ipc', () => ({ invoke: vi.fn<() => Promise<string>>() }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** A fresh window: the icon modules loaded again, with no glyphs in. */
async function launch() {
  vi.resetModules()
  return { ...(await import('./Icon')), ...(await import('./kubai')) }
}

afterEach(() => {
  vi.doUnmock('./kubaiGlyphs')
  vi.restoreAllMocks()
})

describe('the Kubai icon set', () => {
  it('names only Devot icons, each drawn by a glyph that was generated', () => {
    expect(
      Object.keys(catalog.symbols).filter((name) => !(ICONS as string[]).includes(name)),
    ).toEqual([])
    const missing = Object.values(catalog.symbols).filter((glyph) => !(glyph in KUBAI_GLYPHS))
    expect(missing).toEqual([])
    expect(Object.keys(KUBAI_GLYPHS).sort()).toEqual(
      [...new Set(Object.values(catalog.symbols))].sort(),
    )
  })

  it('leaves the bare marks, the unset status and the tag dot to Lucide', () => {
    for (const name of ['check', 'nav.back', 'tag', 'status.none', 'stepper.more'])
      expect(catalog.symbols).not.toHaveProperty(name)
  })

  it('uses the dedicated glyphs for gallery, tasks, sync, plugins and appearance', () => {
    expect(catalog.symbols).toMatchObject({
      'layout.gallery': 'gallery-view',
      'format.taskList': 'checkbox',
      progress: 'clipboard-check',
      'phone.settings.sync': 'sync',
      'settings.tile.sync': 'sync',
      'settings.sync': 'sync',
      'settings.tile.plugins': 'component',
      'settings.plugins': 'component',
      'phone.settings.appearance': 'appearance',
      'settings.appearanceMode': 'appearance',
    })
  })

  it('paints through classes, since the window refuses style attributes', () => {
    for (const content of Object.values(KUBAI_GLYPHS)) {
      expect(content).not.toMatch(/ style=|<script|\son\w+=/)
    }
  })
})

describe('a Kubai icon', () => {
  it('paints nothing until its chunk is in, then gives every instance its own ids', async () => {
    const { Icon } = await launch()
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() =>
      root.render(
        <>
          <Icon name="import.folder" size="md" />
          <Icon name="import.folder" size="md" />
        </>,
      ),
    )
    expect(host.querySelector('[data-pending][data-kubai="folder"]')).not.toBeNull()
    await vi.waitFor(() => expect(host.querySelectorAll('svg.icon-kubai')).toHaveLength(2))
    const [first, second] = [...host.querySelectorAll('svg.icon-kubai')]
    expect(first?.classList).toContain('icon-md')
    expect(first?.innerHTML).not.toContain('__K__')
    const ids = (svg: Element | undefined) =>
      [...(svg?.querySelectorAll('[id]') ?? [])].map((el) => el.id)
    expect(ids(first).length).toBeGreaterThan(0)
    expect(ids(first).filter((id) => ids(second).includes(id))).toEqual([])
    act(() => root.unmount())
  })

  it('stays a Lucide mark where Kubai draws none', async () => {
    const { Icon } = await launch()
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(<Icon name="check" size="sm" />))
    expect(host.querySelector('svg.lucide')).not.toBeNull()
    expect(host.querySelector('[data-kubai]')).toBeNull()
    act(() => root.unmount())
  })

  it('falls back to Lucide when the chunk cannot load', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.doMock('./kubaiGlyphs', () => {
      throw new Error('E_TEST')
    })
    const { Icon, iconElement } = await launch()
    const host = document.createElement('div')
    const root = createRoot(host)
    const element = iconElement('search', 16)
    act(() => root.render(<Icon name="trash" size="md" />))
    await vi.waitFor(() => expect(host.querySelector('svg.lucide')).not.toBeNull())
    expect(console.warn).toHaveBeenCalledWith('W_KUBAI_GLYPHS_UNAVAILABLE')
    await vi.waitFor(() => expect(element.querySelector('svg.lucide')).not.toBeNull())
    expect(element.dataset['pending']).toBeUndefined()
    act(() => root.unmount())
  })

  it('fills a plain element once the chunk is in, without a React root', async () => {
    const { iconElement } = await launch()
    const element = iconElement('search', 16)
    expect(element.dataset['pending']).toBe('')
    await vi.waitFor(() => expect(element.querySelector('svg.icon-kubai')).not.toBeNull())
    expect(element.dataset['pending']).toBeUndefined()
    expect(element.querySelector('svg')?.getAttribute('width')).toBe('16')
    expect(element.getAttribute('style')).toBeNull()
  })
})
