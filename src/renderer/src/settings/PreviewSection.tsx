import { useEditorSettings } from '../editorSettings'
import { t } from '../i18n'
import { SettingToggle, SettingsSection, useSettingsChange } from './controls'
import { useOnPhone } from './onPhone'
import { failureText } from '../failure'

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
          {failureText('previewSettings.failed', error)}
        </p>
      ) : null}
      <SettingsSection title="previewSettings.title" titleHidden={onPhone}>
        {onPhone ? null : (
          <SettingToggle
            label="previewSettings.syncScroll"
            description="previewSettings.syncScrollHint"
            checked={settings.syncScroll}
            onChange={(syncScroll) => change({ syncScroll })}
          />
        )}
        <SettingToggle
          label="previewSettings.remoteImages"
          description="previewSettings.remoteImagesHint"
          checked={settings.loadRemoteImages}
          onChange={(loadRemoteImages) => change({ loadRemoteImages })}
        />
      </SettingsSection>
    </section>
  )
}
