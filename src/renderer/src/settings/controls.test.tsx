import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SettingToggle } from './controls'

const toggle = (props: { checked: boolean; disabled?: boolean }) =>
  renderToStaticMarkup(
    <SettingToggle
      label="editorSettings.toolbar"
      description="editorSettings.toolbarHint"
      onChange={() => {}}
      {...props}
    />,
  )

describe('SettingToggle', () => {
  it('is a switch that keeps the checkbox state and label', () => {
    const html = toggle({ checked: true })
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('role="switch"')
    expect(html).toContain('checked=""')
    expect(html).toContain('aria-labelledby')
    expect(html).toContain('aria-describedby')
  })

  it('is off and enabled by default, and can be disabled', () => {
    expect(toggle({ checked: false })).not.toContain('checked=""')
    expect(toggle({ checked: false })).not.toContain('disabled=""')
    expect(toggle({ checked: false, disabled: true })).toContain('disabled=""')
  })
})
