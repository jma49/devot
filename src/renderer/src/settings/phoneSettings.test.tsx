// @vitest-environment happy-dom
// Settings rows that do nothing on an iPhone are left out of its panes.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_EDITOR_SETTINGS, type EditorSettings } from '../../../core/editorSettings'
import { setIPhoneWording, t } from '../i18n'
import { FontFamilySetting } from './FontChoice'
import { OnPhone } from './onPhone'
import { PreviewSection } from './PreviewSection'

vi.mock('../ipc', () => ({ invoke: vi.fn<() => Promise<null>>(async () => null) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted: Root[] = []

afterEach(() => {
  for (const root of mounted.splice(0)) act(() => root.unmount())
  setIPhoneWording(false)
})

function text(node: ReactNode, onPhone: boolean): HTMLElement {
  const host = document.createElement('div')
  const root = createRoot(host)
  mounted.push(root)
  act(() => root.render(<OnPhone.Provider value={onPhone}>{node}</OnPhone.Provider>))
  return host
}

const families = (settings: EditorSettings, onPhone: boolean) =>
  [
    ...text(
      <FontFamilySetting
        slot="note"
        settings={settings}
        change={() => {}}
        id={(name) => `note-${name}`}
      />,
      onPhone,
    ).querySelectorAll('option'),
  ].map((option) => option.value)

describe('the iPhone Settings panes', () => {
  it('leave out Synced Scrolling, as the phone has no split view', () => {
    expect(text(<PreviewSection />, false).textContent).toContain('Synced Scrolling')
    const phone = text(<PreviewSection />, true).textContent
    expect(phone).not.toContain('Synced Scrolling')
    expect(phone).toContain('Load Images from the Web')
  })

  it('offer no Installed Font, as iOS lists none, unless it is already chosen', () => {
    expect(families(DEFAULT_EDITOR_SETTINGS, false)).toContain('installed')
    expect(families(DEFAULT_EDITOR_SETTINGS, true)).not.toContain('installed')
    expect(families(DEFAULT_EDITOR_SETTINGS, true)).toContain('imported')
    const installed = { ...DEFAULT_EDITOR_SETTINGS, fontFamily: 'installed' as const }
    expect(families(installed, true)).toContain('installed')
  })

  it('name the Toolbar for what it shows on the phone, not the bar above the keyboard', () => {
    setIPhoneWording(true)
    expect(t('editorSettings.toolbar')).toBe('Floating Toolbars')
    expect(t('editorSettings.toolbarHint')).toBe('Over selected text and tables')
  })
})
