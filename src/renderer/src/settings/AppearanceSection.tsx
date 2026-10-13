import { useId } from 'react'
import { APPEARANCES, type AppearanceChoice } from '../../../core/editorSettings'
import { useEditorSetting } from '../editorSettings'
import { format, t, type MessageKey } from '../i18n'
import { FormGroup, FormRow, SettingsFlag, useSettingsChange } from './controls'

const CARD_LABELS: Readonly<Record<AppearanceChoice, MessageKey>> = {
  light: 'appearanceSettings.light',
  dark: 'appearanceSettings.dark',
  system: 'appearanceSettings.system',
}

/**
 * A few lines of Markdown in one appearance's colours, whatever the window
 * shows (`data-appearance-preview`, read by the generated tokens).
 */
function Preview({ appearance }: { appearance: 'light' | 'dark' }) {
  return (
    <span className="theme-preview" data-appearance-preview={appearance} aria-hidden="true">
      <span className="theme-preview-heading">
        <span className="theme-preview-markup">#</span> {t('appearanceSettings.previewHeading')}
      </span>
      <span>
        <span className="theme-preview-list">-</span> {t('appearanceSettings.previewItem')}
      </span>
      <span>
        <span className="theme-preview-markup">`</span>
        <span className="theme-preview-keyword">{t('appearanceSettings.previewCode')}</span>
        <span className="theme-preview-markup">`</span>
      </span>
    </span>
  )
}

/**
 * Settings > Appearance: Light, Dark or Match System (the default), as
 * cards with a small preview; whether the accent follows the macOS accent
 * colour (off by default: Devot's palette); and whether the window shows the
 * sidebar material (on by default). Off, the sidebar paints an opaque
 * surface and the main window drops its effect (sidebarMaterial.ts). Every
 * change applies at once, without a restart. The settings are stored with
 * the editor settings, so changes made elsewhere show here as they happen.
 */
export function AppearanceSection() {
  const appearance = useEditorSetting('appearance')
  const systemAccent = useEditorSetting('systemAccent')
  const material = useEditorSetting('sidebarMaterial')
  const [error, change] = useSettingsChange()
  const id = useId()
  const hint = `${id}-material-hint`
  const accentHint = `${id}-accent-hint`

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
        <FormRow label="appearanceSettings.appearance">
          <div
            className="theme-cards"
            role="radiogroup"
            aria-label={t('appearanceSettings.appearance')}
          >
            {APPEARANCES.map((choice) => (
              <label key={choice} className="theme-card">
                <input
                  type="radio"
                  className="visually-hidden"
                  name={`${id}-appearance`}
                  value={choice}
                  checked={appearance === choice}
                  onChange={() => change({ appearance: choice })}
                />
                <span className="theme-card-previews">
                  {choice === 'system' ? (
                    <>
                      <Preview appearance="light" />
                      <Preview appearance="dark" />
                    </>
                  ) : (
                    <Preview appearance={choice} />
                  )}
                </span>
                <span className="theme-card-name">{t(CARD_LABELS[choice])}</span>
              </label>
            ))}
          </div>
        </FormRow>
        <FormRow label="appearanceSettings.accent">
          <SettingsFlag
            label="appearanceSettings.systemAccent"
            checked={systemAccent}
            hint={{ id: accentHint, text: 'appearanceSettings.systemAccentHint' }}
            onChange={(checked) => change({ systemAccent: checked })}
          />
        </FormRow>
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
