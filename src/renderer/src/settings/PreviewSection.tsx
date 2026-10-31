import { useEditorSettings } from '../editorSettings'
import { format, t } from '../i18n'
import { SettingToggle, SettingsSection, useSettingsChange } from './controls'

export function PreviewSection() {
  const settings = useEditorSettings()
  const [error, change] = useSettingsChange()

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
      <SettingsSection title="previewSettings.title">
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
