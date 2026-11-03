import { useEditorSettings } from '../editorSettings'
import { format, t } from '../i18n'
import { SettingToggle, SettingsSection, useSettingsChange } from './controls'
import { useOnPhone } from './onPhone'

export function PreviewSection() {
  const settings = useEditorSettings()
  const [error, change] = useSettingsChange()
  const onPhone = useOnPhone()

  return (
    <section className="settings-section" aria-labelledby="preview-title">
      <h2 id="preview-title" className="visually-hidden">
        {t('previewSettings.title')}
      </h2>
      {error ? (
        <p role="alert" className="settings-error">
          {format(t('previewSettings.failed'), { code: error })}
        </p>
      ) : null}
      <SettingsSection title="previewSettings.title" titleHidden={onPhone}>
        <SettingToggle
          label="previewSettings.syncScroll"
          description="previewSettings.syncScrollHint"
          checked={settings.syncScroll}
          onChange={(syncScroll) => change({ syncScroll })}
        />
      </SettingsSection>
    </section>
  )
}
