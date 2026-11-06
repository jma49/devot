import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Select, SettingToggle } from './controls'
import { OnPhone } from './onPhone'

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

describe('Select', () => {
  const select = (onPhone: boolean) =>
    renderToStaticMarkup(
      <OnPhone.Provider value={onPhone}>
        <Select value="a" onChange={() => {}}>
          <option value="a">A</option>
        </Select>
      </OnPhone.Provider>,
    )

  it('ends a phone row with the value and the disclosure chevron', () => {
    const html = select(true)
    expect(html).toContain('select-value')
    expect(html).toContain('phone-chevron')
    expect(html).not.toContain('select-chevron')
  })

  it('keeps the round up and down chevron on the Mac', () => {
    const html = select(false)
    expect(html).toContain('select-chevron')
    expect(html).not.toContain('phone-chevron')
  })
})
