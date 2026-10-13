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
})
