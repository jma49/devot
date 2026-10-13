import { useId } from 'react'
import { useEditorSetting } from '../editorSettings'
import { format, t } from '../i18n'
import { FormGroup, FormRow, SettingsFlag, useSettingsChange } from './controls'

/**
 * Settings > Appearance: whether the window shows the sidebar material
 * (on by default). Off, the sidebar paints an opaque surface and the main
 * window drops its effect (sidebarMaterial.ts); the change applies at once,
 * without a restart. The setting is stored with the editor settings, so
 * changes made elsewhere show here as they happen.
 */
export function AppearanceSection() {
  const material = useEditorSetting('sidebarMaterial')
  const [error, change] = useSettingsChange()
  const hint = `${useId()}-material-hint`

  return (
    <section className="settings-section" aria-labelledby="appearance-title">
      <h2 id="appearance-title" className="visually-hidden">
        {t('appearanceSettings.title')}
      </h2>
      {error ? (
        <p role="alert" className="settings-error">
          {format(t('appearanceSettings.failed'), { code: error })}
        </p>
      ) : null}
      <FormGroup>
        <FormRow label="appearanceSettings.sidebar">
          <SettingsFlag
            label="appearanceSettings.sidebarMaterial"
            checked={material}
            hint={{ id: hint, text: 'appearanceSettings.sidebarMaterialHint' }}
            onChange={(checked) => change({ sidebarMaterial: checked })}
          />
        </FormRow>
      </FormGroup>
    </section>
  )
}
