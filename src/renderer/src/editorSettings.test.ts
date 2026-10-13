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
  it('sets the editor size and the preview scale that follows it', () => {
    const set = styled(DEFAULT_EDITOR_SETTINGS.fontSize)
    expect(set.get('--editor-font-size')).toBe('13px')
    expect(set.get('--preview-scale')).toBe('1')
    expect(Number(styled(26).get('--preview-scale'))).toBe(2)
    expect(Number(styled(13 / 2 + 6.5 / 2).get('--preview-scale'))).toBeCloseTo(0.75, 5)
  })
})
