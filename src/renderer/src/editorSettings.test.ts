import { describe, expect, it } from 'vitest'
import { DEFAULT_EDITOR_SETTINGS } from '../../core/editorSettings'
import { applyEditorStyle } from './editorSettings'

function styled(fontSize: number) {
  const set = new Map<string, string>()
  applyEditorStyle(
    { ...DEFAULT_EDITOR_SETTINGS, fontSize },
    { setProperty: (name, value) => void set.set(name, value) },
  )
  return set
}

describe('applyEditorStyle', () => {
  it('sets the editor size and weight, and the preview scale from the preview size', () => {
    const set = styled(DEFAULT_EDITOR_SETTINGS.fontSize)
    expect(set.get('--editor-font-size')).toBe('13px')
    expect(set.get('--editor-font-weight')).toBe('normal')
    expect(set.get('--window-transparency')).toBe('50')
    // The editor's size no longer moves the preview; its own size does.
    expect(set.get('--preview-scale')).toBe(styled(26).get('--preview-scale'))
    expect(Number(set.get('--preview-scale'))).toBeCloseTo(15 / 13.5, 5)
    const bigger = new Map<string, string>()
    applyEditorStyle(
      { ...DEFAULT_EDITOR_SETTINGS, previewFontSize: 27, fontWeight: '600' },
      { setProperty: (name, value) => void bigger.set(name, value) },
    )
    expect(Number(bigger.get('--preview-scale'))).toBeCloseTo(2, 5)
    expect(bigger.get('--editor-font-weight')).toBe('600')
  })

  it('sets the three fonts, and the preview takes the note font once it is not the default', () => {
    const fonts = (patch: Partial<typeof DEFAULT_EDITOR_SETTINGS>, loaded = () => true) => {
      const set = new Map<string, string>()
      applyEditorStyle(
        { ...DEFAULT_EDITOR_SETTINGS, ...patch },
        { setProperty: (name, value) => void set.set(name, value) },
        loaded,
      )
      return set
    }
    const plain = fonts({})
    expect(plain.get('--font-family-ui')).toMatch(/^-apple-system/)
    expect(plain.get('--editor-font-family')).toBe('var(--font-family-mono)')
    expect(plain.get('--code-font-family')).toBe('var(--font-family-mono)')
    expect(plain.get('--preview-font-family')).toBe('var(--font-family-ui)')
    const menlo = fonts({ fontFamily: 'menlo' })
    expect(menlo.get('--preview-font-family')).toBe(menlo.get('--editor-font-family'))
    // An imported face is named only once it has loaded.
    const code = { codeFontFamily: 'imported', codeImportedFont: 'Fira Code.ttf' } as const
    expect(fonts(code, () => false).get('--code-font-family')).toBe('var(--font-family-mono)')
    expect(fonts(code).get('--code-font-family')).toBe(
      '"Devot Font Fira Code ttf", var(--font-family-mono)',
    )
  })
})
