import { useId } from 'react'
import {
  APPEARANCES,
  DEFAULT_EDITOR_SETTINGS,
  THEMES,
  WINDOW_TRANSPARENCY_MAX,
  WINDOW_TRANSPARENCY_STEP,
  themeFollowsSystemAccent,
  type AppearanceChoice,
  type ThemeChoice,
} from '../../../core/editorSettings'
import { useEditorSetting } from '../editorSettings'
import { format, t, type MessageKey } from '../i18n'
import { Setting, SettingToggle, SettingsSection, useSettingsChange } from './controls'
import { useDraggedNumber } from './draggedNumber'

/** What the Transparency slider says it shows: the design washes, or more or less of the desktop. */
function transparencyText(value: number): string {
  const design = DEFAULT_EDITOR_SETTINGS.windowTransparency
  if (value === design) return t('appearanceSettings.windowTransparencyDefault')
  return t(
    value < design
      ? 'appearanceSettings.windowTransparencyMoreOpaque'
      : 'appearanceSettings.windowTransparencyMoreClear',
  )
}

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
 * option is hidden while it is chosen); whether the accent follows the macOS accent
 * colour (off by default: Devot's palette); and whether the whole window shows
 * the material (on by default), and how see-through its regions are (a
 * slider from Opaque to Transparent that starts at the design washes and
 * applies while it is dragged, with a Reset back to them; off while the
 * material is). Off, every
 * region paints an opaque surface and the main window drops its effect
 * (sidebarMaterial.ts). Every
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
  const transparency = useDraggedNumber({
    stored: useEditorSetting('windowTransparency'),
    store: (windowTransparency) => change({ windowTransparency }),
  })

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
      {themeFollowsSystemAccent(theme) ? (
        <SettingsSection icon="settings.accent" title="appearanceSettings.accent">
          <SettingToggle
            label="appearanceSettings.systemAccent"
            description="appearanceSettings.systemAccentHint"
            checked={systemAccent}
            onChange={(checked) => change({ systemAccent: checked })}
          />
        </SettingsSection>
      ) : null}
      <SettingsSection icon="settings.sidebar" title="appearanceSettings.sidebar">
        <SettingToggle
          label="appearanceSettings.sidebarMaterial"
          description="appearanceSettings.sidebarMaterialHint"
          checked={material}
          onChange={(sidebarMaterial) => change({ sidebarMaterial })}
        />
        <Setting
          label="appearanceSettings.windowTransparency"
          description={t('appearanceSettings.windowTransparencyHint')}
          htmlFor={`${id}-transparency`}
          descriptionId={`${id}-transparency-hint`}
        >
          <div className="setting-range">
            <span className="setting-range-end" aria-hidden="true">
              {t('appearanceSettings.windowTransparencyOpaque')}
            </span>
            <input
              id={`${id}-transparency`}
              type="range"
              min={-WINDOW_TRANSPARENCY_MAX}
              max={WINDOW_TRANSPARENCY_MAX}
              step={WINDOW_TRANSPARENCY_STEP}
              list={`${id}-transparency-default`}
              value={transparency.value}
              disabled={!material}
              aria-describedby={`${id}-transparency-hint`}
              aria-valuetext={transparencyText(transparency.value)}
              onChange={(e) => transparency.drag(Number(e.currentTarget.value))}
              onPointerUp={transparency.release}
              onKeyUp={transparency.release}
              onBlur={transparency.release}
            />
            {/* A tick at the design washes, where the thumb starts. */}
            <datalist id={`${id}-transparency-default`}>
              <option value={DEFAULT_EDITOR_SETTINGS.windowTransparency} />
            </datalist>
            <span className="setting-range-end" aria-hidden="true">
              {t('appearanceSettings.windowTransparencyClear')}
            </span>
          </div>
          {transparency.value !== DEFAULT_EDITOR_SETTINGS.windowTransparency && (
            <button
              type="button"
              className="button"
              disabled={!material}
              onClick={() =>
                change({ windowTransparency: DEFAULT_EDITOR_SETTINGS.windowTransparency })
              }
            >
              {t('appearanceSettings.windowTransparencyReset')}
            </button>
          )}
        </Setting>
      </SettingsSection>
    </section>
  )
}
