import { useId, useMemo, type CSSProperties, type ReactNode } from 'react'
import {
  ANIMATIONS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  ICON_STYLES,
  INTERFACE_STYLES,
  THEMES,
  WINDOW_TRANSPARENCY_MAX,
  WINDOW_TRANSPARENCY_STEP,
  interfaceStyle,
  interfaceStylePatch,
  themeFollowsSystemAccent,
  themeInEffect,
  type AnimationsChoice,
  type AppearanceChoice,
  type IconStyleChoice,
  type InterfaceStyle,
  type ThemeChoice,
} from '../../../core/editorSettings'
import { useEditorSettings } from '../editorSettings'
import { commandKeys } from '../commands/registry'
import { shortcutLabel } from '../commands/keys'
import { useKeymap } from '../commands/shortcutSettings'
import { currentLocale, format, t, type MessageKey } from '../i18n'
import {
  NumberStepper,
  Select,
  Setting,
  SettingToggle,
  SettingsSection,
  useSettingsChange,
} from './controls'
import { StyledIcon, useAppearance } from '../icons/Icon'
import { FontChoice } from './FontChoice'
import { useTypedNumber } from './typedNumber'
import type { IconName } from '../icons/symbols'
import { useDraggedNumber } from './draggedNumber'
import type { Appearance } from '../theme/appearance'

/** The font size description: what it is, and the keys in effect (or the palette's commands when one has no key). */
function fontSizeHint(): string {
  const [bigger, smaller, reset] = (
    ['view.fontBigger', 'view.fontSmaller', 'view.fontReset'] as const
  ).map((id) => commandKeys(id)[0])
  const keys =
    bigger === undefined || smaller === undefined || reset === undefined
      ? t('editorSettings.fontSizeKeysNone')
      : format(t('editorSettings.fontSizeKeys'), {
          bigger: shortcutLabel(bigger),
          smaller: shortcutLabel(smaller),
          reset: shortcutLabel(reset),
        })
  return `${t('editorSettings.fontSizeHint')} ${keys}`
}

const ANIMATION_LABELS: Readonly<Record<AnimationsChoice, MessageKey>> = {
  always: 'appearanceSettings.animations.always',
  system: 'appearanceSettings.animations.system',
  off: 'appearanceSettings.animations.off',
}

const SCHEMES: readonly AppearanceChoice[] = ['system', 'light', 'dark']

const SCHEME_LABELS: Readonly<Record<AppearanceChoice, MessageKey>> = {
  system: 'appearanceSettings.system',
  light: 'appearanceSettings.light',
  dark: 'appearanceSettings.dark',
}

const STYLE_LABELS: Readonly<Record<InterfaceStyle, MessageKey>> = {
  classic: 'appearanceSettings.interfaceClassic',
  glass: 'appearanceSettings.interfaceGlass',
}

const THEME_LABELS: Readonly<Record<ThemeChoice, MessageKey>> = {
  default: 'appearanceSettings.themeDefault',
  ivory: 'appearanceSettings.themeIvory',
  dawn: 'appearanceSettings.themeDawn',
  tide: 'appearanceSettings.themeTide',
  sage: 'appearanceSettings.themeSage',
  ember: 'appearanceSettings.themeEmber',
}

const BUILT_IN_THEMES = THEMES.filter((theme) => theme !== 'default')

const ICON_STYLE_LABELS: Readonly<Record<IconStyleChoice, MessageKey>> = {
  sfSymbols: 'appearanceSettings.iconStyleSfSymbols',
  lucide: 'appearanceSettings.iconStyleLucide',
}

const ICON_SAMPLES: readonly IconName[] = ['notes.all', 'note.pinned', 'search']

/** A theme's palette as dots on its swatch: its text, then its syntax colours, then its accent. */
const PALETTE = [
  'text-editor',
  'syntax-heading',
  'syntax-list-alt',
  'syntax-string',
  'syntax-function',
  'syntax-markup',
  'syntax-keyword',
  'accent-fill',
] as const

const themePreview = (theme: ThemeChoice) => (theme === 'default' ? undefined : theme)

/** A radio shown as a thumbnail with its name under it. */
function Choice({
  group,
  checked,
  onChange,
  label,
  className,
  children,
}: {
  group: string
  checked: boolean
  onChange: () => void
  label: string
  className: string
  children: ReactNode
}) {
  return (
    <label className={`choice ${className}`}>
      <input
        type="radio"
        className="visually-hidden"
        name={group}
        checked={checked}
        onChange={onChange}
      />
      <span className="choice-frame">{children}</span>
      <span className="choice-name">{label}</span>
    </label>
  )
}

/**
 * A small window over a wallpaper, in one appearance and theme (`data-appearance-preview` and
 * `data-theme-preview`, read by the generated tokens). Glass lets the wallpaper through the window.
 */
function WindowThumb({
  appearance,
  theme,
  glass,
}: {
  appearance: Appearance
  theme: ThemeChoice
  glass: boolean
}) {
  return (
    <span
      className="window-thumb"
      data-appearance-preview={appearance}
      data-theme-preview={themePreview(theme)}
      data-glass={glass || undefined}
    >
      <span className="window-thumb-window">
        <span className="window-thumb-lights">
          <span />
          <span />
          <span />
        </span>
        <span className="window-thumb-bar" />
        <span className="window-thumb-panes">
          <span />
          <span />
        </span>
      </span>
    </span>
  )
}

/** Light and dark along one diagonal; the name stays under the thumbnail, clear of the split. */
function AutoThumb({
  themes,
  glass,
}: {
  themes: Readonly<Record<Appearance, ThemeChoice>>
  glass: boolean
}) {
  return (
    <span className="choice-thumb auto-thumb" aria-hidden="true">
      <span className="auto-thumb-light">
        <WindowThumb appearance="light" theme={themes.light} glass={glass} />
      </span>
      <span className="auto-thumb-dark">
        <WindowThumb appearance="dark" theme={themes.dark} glass={glass} />
      </span>
    </span>
  )
}

function ThemeSwatch({ appearance, theme }: { appearance: Appearance; theme: ThemeChoice }) {
  return (
    <span
      className="swatch"
      data-appearance-preview={appearance}
      data-theme-preview={themePreview(theme)}
      aria-hidden="true"
    >
      <span className="swatch-top">
        <span className="swatch-sample">{t('appearanceSettings.swatchSample')}</span>
        <span className="swatch-path">{t('appearanceSettings.swatchPath')}</span>
        <span className="swatch-accent" />
      </span>
      <span className="swatch-dots">
        {PALETTE.map((token) => (
          <span key={token} style={{ background: `var(--color-${token})` }} />
        ))}
      </span>
    </span>
  )
}

/** One appearance's themes: Default, a divider, then the built-in ones, in one row that scrolls sideways. */
function ThemePicker({
  appearance,
  chosen,
  onChoose,
}: {
  appearance: Appearance
  chosen: ThemeChoice
  onChoose: (theme: ThemeChoice) => void
}) {
  const ids = useId()
  const swatch = (theme: ThemeChoice) => (
    <Choice
      key={theme}
      group={`${ids}-theme`}
      checked={chosen === theme}
      onChange={() => onChoose(theme)}
      label={t(THEME_LABELS[theme])}
      className="theme-choice"
    >
      <ThemeSwatch appearance={appearance} theme={theme} />
    </Choice>
  )
  return (
    <div
      className="swatch-row"
      role="radiogroup"
      aria-label={t(
        appearance === 'light' ? 'appearanceSettings.lightTheme' : 'appearanceSettings.darkTheme',
      )}
    >
      <div className="choice-group">
        <span className="choice-group-label">{t('appearanceSettings.themesDefault')}</span>
        <div className="choice-items">{swatch('default')}</div>
      </div>
      <span className="choice-divider" aria-hidden="true" />
      <div className="choice-group">
        <span className="choice-group-label">{t('appearanceSettings.themesBuiltIn')}</span>
        <div className="choice-items">{BUILT_IN_THEMES.map(swatch)}</div>
      </div>
    </div>
  )
}

/**
 * Settings > Appearance: the color scheme (Auto, Light or Dark) and the interface style (Classic,
 * an opaque window, or Glass, with how see-through it is); a theme for each appearance, the one in
 * effect marked Active (Ivory has its own accent, so the system accent option is hidden while it is in
 * effect); whether things move; the icon style; and the editor's and preview's type. Every change
 * applies at once, and changes made elsewhere show here as they happen.
 */
export function AppearanceSection() {
  const settings = useEditorSettings()
  const shown = useAppearance()
  const [error, change] = useSettingsChange()
  useKeymap()
  const ids = useId()
  const id = (name: string) => `${ids}-${name}`
  const fontSize = useTypedNumber({
    stored: settings.fontSize,
    min: FONT_SIZE_MIN,
    max: FONT_SIZE_MAX,
    store: (size) => change({ fontSize: size }),
  })
  const previewSize = useTypedNumber({
    stored: settings.previewFontSize,
    min: FONT_SIZE_MIN,
    max: FONT_SIZE_MAX,
    store: (previewFontSize) => change({ previewFontSize }),
  })
  const locale = currentLocale()
  const signed = useMemo(
    () => new Intl.NumberFormat(locale, { signDisplay: 'exceptZero' }),
    [locale],
  )
  const glassAmount = useDraggedNumber({
    stored: settings.windowTransparency,
    store: (windowTransparency) => change({ windowTransparency }),
  })
  const style = interfaceStyle(settings)
  const themes = { light: settings.lightTheme, dark: settings.darkTheme }
  const glass = style === 'glass'
  const modeTitle = (appearance: Appearance) =>
    appearance === shown ? t('appearanceSettings.modeActive') : undefined

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
      <SettingsSection
        title="appearanceSettings.groupAppearance"
        footnote={t('appearanceSettings.interfaceStyleNote')}
      >
        <div className="choice-groups">
          <div className="choice-group" role="radiogroup" aria-labelledby={id('scheme')}>
            <span id={id('scheme')} className="choice-group-label">
              {t('appearanceSettings.colorScheme')}
            </span>
            <div className="choice-items">
              {SCHEMES.map((choice) => (
                <Choice
                  key={choice}
                  group={id('scheme-choice')}
                  checked={settings.appearance === choice}
                  onChange={() => change({ appearance: choice })}
                  label={t(SCHEME_LABELS[choice])}
                  className="thumb-choice"
                >
                  {choice === 'system' ? (
                    <AutoThumb themes={themes} glass={glass} />
                  ) : (
                    <span className="choice-thumb" aria-hidden="true">
                      <WindowThumb appearance={choice} theme={themes[choice]} glass={glass} />
                    </span>
                  )}
                </Choice>
              ))}
            </div>
          </div>
          <span className="choice-divider" aria-hidden="true" />
          <div className="choice-group" role="radiogroup" aria-labelledby={id('style')}>
            <span id={id('style')} className="choice-group-label">
              {t('appearanceSettings.interfaceStyle')}
            </span>
            <div className="choice-items">
              {INTERFACE_STYLES.map((choice) => (
                <Choice
                  key={choice}
                  group={id('style-choice')}
                  checked={style === choice}
                  onChange={() => change(interfaceStylePatch(choice))}
                  label={t(STYLE_LABELS[choice])}
                  className="thumb-choice"
                >
                  <span className="choice-thumb" aria-hidden="true">
                    <WindowThumb
                      appearance={shown}
                      theme={themes[shown]}
                      glass={choice === 'glass'}
                    />
                  </span>
                </Choice>
              ))}
            </div>
          </div>
        </div>
        {glass ? (
          <Setting
            label="appearanceSettings.glassAmount"
            description={t('appearanceSettings.glassAmountHint')}
            htmlFor={id('glass')}
            descriptionId={id('glass-hint')}
          >
            <span className="setting-range">
              <input
                id={id('glass')}
                type="range"
                className="slider"
                min={-WINDOW_TRANSPARENCY_MAX}
                max={WINDOW_TRANSPARENCY_MAX}
                step={WINDOW_TRANSPARENCY_STEP}
                value={glassAmount.value}
                style={
                  {
                    '--value': glassAmount.value,
                    '--min': -WINDOW_TRANSPARENCY_MAX,
                    '--max': WINDOW_TRANSPARENCY_MAX,
                  } as CSSProperties
                }
                aria-describedby={id('glass-hint')}
                onChange={(e) => glassAmount.drag(Number(e.currentTarget.value))}
                onPointerUp={glassAmount.release}
                onKeyUp={glassAmount.release}
                onBlur={glassAmount.release}
              />
              <output className="setting-range-value" htmlFor={id('glass')}>
                {signed.format(glassAmount.value)}
              </output>
            </span>
          </Setting>
        ) : null}
        {themeFollowsSystemAccent(themeInEffect(settings, shown)) ? (
          <SettingToggle
            label="appearanceSettings.systemAccent"
            description="appearanceSettings.systemAccentHint"
            checked={settings.systemAccent}
            onChange={(checked) => change({ systemAccent: checked })}
          />
        ) : null}
      </SettingsSection>
      <SettingsSection title="appearanceSettings.lightMode" titleSuffix={modeTitle('light')}>
        <ThemePicker
          appearance="light"
          chosen={settings.lightTheme}
          onChoose={(lightTheme) => change({ lightTheme })}
        />
      </SettingsSection>
      <SettingsSection title="appearanceSettings.darkMode" titleSuffix={modeTitle('dark')}>
        <ThemePicker
          appearance="dark"
          chosen={settings.darkTheme}
          onChoose={(darkTheme) => change({ darkTheme })}
        />
      </SettingsSection>
      <SettingsSection title="appearanceSettings.groupMotion">
        <Setting
          label="appearanceSettings.animations"
          description={t('appearanceSettings.animationsHint')}
          htmlFor={id('animations')}
          descriptionId={id('animations-hint')}
        >
          <Select
            id={id('animations')}
            value={settings.animations}
            aria-describedby={id('animations-hint')}
            onChange={(e) => change({ animations: e.currentTarget.value as AnimationsChoice })}
          >
            {ANIMATIONS.map((choice) => (
              <option key={choice} value={choice}>
                {t(ANIMATION_LABELS[choice])}
              </option>
            ))}
          </Select>
        </Setting>
      </SettingsSection>
      <SettingsSection
        title="appearanceSettings.groupIcons"
        footnote={t('appearanceSettings.iconStyleHint')}
      >
        <div className="choice-groups">
          <div
            className="choice-items"
            role="radiogroup"
            aria-label={t('appearanceSettings.iconStyle')}
          >
            {ICON_STYLES.map((choice) => (
              <Choice
                key={choice}
                group={id('icon-style')}
                checked={settings.iconStyle === choice}
                onChange={() => change({ iconStyle: choice })}
                label={t(ICON_STYLE_LABELS[choice])}
                className="thumb-choice"
              >
                <span className="choice-thumb icon-thumb" aria-hidden="true">
                  {ICON_SAMPLES.map((name) => (
                    <StyledIcon key={name} style={choice} name={name} size="lg" />
                  ))}
                </span>
              </Choice>
            ))}
          </div>
        </div>
      </SettingsSection>
      <SettingsSection title="appearanceSettings.groupTypography">
        <FontChoice slot="note" settings={settings} change={change} id={id} />
        <Setting
          label="appearanceSettings.editorFontSize"
          description={fontSizeHint()}
          htmlFor={id('size')}
          descriptionId={id('size-hint')}
        >
          <NumberStepper
            id={id('size')}
            value={fontSize.value}
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
            onType={fontSize.type}
            onLeave={fontSize.leave}
            describedBy={id('size-hint')}
          />
        </Setting>
        <Setting
          label="appearanceSettings.previewFontSize"
          description={t('previewSettings.fontSizeHint')}
          htmlFor={id('preview-size')}
          descriptionId={id('preview-size-hint')}
        >
          <NumberStepper
            id={id('preview-size')}
            value={previewSize.value}
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
            onType={previewSize.type}
            onLeave={previewSize.leave}
            describedBy={id('preview-size-hint')}
          />
        </Setting>
      </SettingsSection>
    </section>
  )
}
