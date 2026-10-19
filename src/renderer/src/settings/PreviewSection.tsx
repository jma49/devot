import { useId } from 'react'
import { FONT_SIZE_MAX, FONT_SIZE_MIN } from '../../../core/editorSettings'
import { useEditorSettings } from '../editorSettings'
import { format, t } from '../i18n'
import { Setting, SettingToggle, SettingsSection, useSettingsChange } from './controls'
import { useTypedNumber } from './typedNumber'

export function PreviewSection() {
  const settings = useEditorSettings()
  const [error, change] = useSettingsChange()
  const ids = useId()
  const size = useTypedNumber({
    stored: settings.previewFontSize,
    min: FONT_SIZE_MIN,
    max: FONT_SIZE_MAX,
    store: (previewFontSize) => change({ previewFontSize }),
  })

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
      <SettingsSection icon="settings.preview" title="previewSettings.title">
        <Setting
          label="previewSettings.fontSize"
          description={t('previewSettings.fontSizeHint')}
          htmlFor={`${ids}-size`}
          descriptionId={`${ids}-size-hint`}
        >
          <input
            id={`${ids}-size`}
            type="number"
            className="settings-number"
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
            step={1}
            value={size.value}
            aria-describedby={`${ids}-size-hint`}
            onChange={(e) => size.type(e.currentTarget.value)}
            onBlur={size.leave}
          />
        </Setting>
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
