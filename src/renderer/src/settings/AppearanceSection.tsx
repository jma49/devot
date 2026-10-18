import { useId } from 'react'
import {
  APPEARANCES,
  THEMES,
  themeFollowsSystemAccent,
  type AppearanceChoice,
  type ThemeChoice,
} from '../../../core/editorSettings'
import { useEditorSetting } from '../editorSettings'
import { format, t, type MessageKey } from '../i18n'
import { SettingToggle, SettingsSection, useSettingsChange } from './controls'

const CARD_LABELS: Readonly<Record<AppearanceChoice, MessageKey>> = {
  light: 'appearanceSettings.light',
  dark: 'appearanceSettings.dark',
  system: 'appearanceSettings.system',
}

const THEME_LABELS: Readonly<Record<ThemeChoice, MessageKey>> = {
  default: 'appearanceSettings.themeDefault',
  ivory: 'appearanceSettings.themeIvory',
}

/**
 * A few lines of Markdown in one theme's and appearance's colours, whatever
 * the window shows (`data-appearance-preview` and `data-theme-preview`, read
 * by the generated tokens; the default theme needs no theme mark).
 */
function Preview({
  appearance,
  theme = 'default',
}: {
  appearance: 'light' | 'dark'
  theme?: ThemeChoice
}) {
  return (
    <span
      className="theme-preview"
      data-appearance-preview={appearance}
      data-theme-preview={theme === 'default' ? undefined : theme}
      aria-hidden="true"
    >
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
 * cards with a small preview; the theme, Default or Ivory, as cards that show
 * each in both appearances (Ivory has its own accent, so the system accent
 * option is off while it is chosen); whether the accent follows the macOS accent
 * colour (off by default: Devot's palette); and whether the window shows the
 * sidebar material (on by default). Off, the sidebar paints an opaque
 * surface and the main window drops its effect (sidebarMaterial.ts). Every
 * change applies at once, without a restart. The settings are stored with
 * the editor settings, so changes made elsewhere show here as they happen.
 */
export function AppearanceSection() {
  const appearance = useEditorSetting('appearance')
  const theme = useEditorSetting('theme')
  const systemAccent = useEditorSetting('systemAccent')
  const material = useEditorSetting('sidebarMaterial')
  const [error, change] = useSettingsChange()
  const id = useId()

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
      <SettingsSection icon="settings.appearanceMode" title="appearanceSettings.appearance">
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
                    <Preview appearance="light" theme={theme} />
                    <Preview appearance="dark" theme={theme} />
                  </>
                ) : (
                  <Preview appearance={choice} theme={theme} />
                )}
              </span>
              <span className="theme-card-name">{t(CARD_LABELS[choice])}</span>
            </label>
          ))}
        </div>
      </SettingsSection>
      <SettingsSection icon="settings.theme" title="appearanceSettings.theme">
        <div className="theme-cards" role="radiogroup" aria-label={t('appearanceSettings.theme')}>
          {THEMES.map((choice) => (
            <label key={choice} className="theme-card">
              <input
                type="radio"
                className="visually-hidden"
                name={`${id}-theme`}
                value={choice}
                checked={theme === choice}
                onChange={() => change({ theme: choice })}
              />
              <span className="theme-card-previews">
                <Preview appearance="light" theme={choice} />
                <Preview appearance="dark" theme={choice} />
              </span>
              <span className="theme-card-name">{t(THEME_LABELS[choice])}</span>
            </label>
          ))}
        </div>
      </SettingsSection>
      <SettingsSection icon="settings.accent" title="appearanceSettings.accent">
        <SettingToggle
          label="appearanceSettings.systemAccent"
          description="appearanceSettings.systemAccentHint"
          note={
            themeFollowsSystemAccent(theme) ? undefined : 'appearanceSettings.systemAccentOwnTheme'
          }
          disabled={!themeFollowsSystemAccent(theme)}
          checked={systemAccent}
          onChange={(checked) => change({ systemAccent: checked })}
        />
      </SettingsSection>
      <SettingsSection icon="settings.sidebar" title="appearanceSettings.sidebar">
        <SettingToggle
          label="appearanceSettings.sidebarMaterial"
          description="appearanceSettings.sidebarMaterialHint"
          checked={material}
          onChange={(sidebarMaterial) => change({ sidebarMaterial })}
        />
      </SettingsSection>
    </section>
  )
}
