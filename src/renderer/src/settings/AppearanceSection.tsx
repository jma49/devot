import { useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import {
  ANIMATIONS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  GRADIENT_STRENGTH_MAX,
  ICON_STYLES,
  THEMES,
  WINDOW_TRANSPARENCY_MAX,
  WINDOW_TRANSPARENCY_STEP,
  gradientThemeChosen,
  themeFollowsSystemAccent,
  themeInEffect,
  type AnimationsChoice,
  type AppearanceChoice,
  type IconStyleChoice,
  type ThemeChoice,
} from '../../../core/editorSettings'
import { useEditorSettings } from '../editorSettings'
import { commandKeys } from '../commands/registry'
import { shortcutLabel } from '../commands/keys'
import { useKeymap } from '../commands/shortcutSettings'
import { currentLocale, format, sentences, t, type MessageKey } from '../i18n'
import {
  NumberStepper,
  Select,
  Setting,
  SettingToggle,
  SettingsSection,
  useSettingsChange,
} from './controls'
import { Icon, StyledIcon, useAppearance } from '../icons/Icon'
import { FontChoice, FontFamilySetting } from './FontChoice'
import { useTypedNumber } from './typedNumber'
import type { IconName } from '../icons/symbols'
import { useDraggedNumber } from './draggedNumber'
import type { Appearance } from '../theme/appearance'
import { failureText } from '../failure'
import { errorCode } from '../backups'
import { watchPlugins } from '../plugins/api'
import {
  choosePluginTheme,
  listPluginThemes,
  NO_PLUGIN_THEMES,
  themeInEffect as pluginThemeInEffect,
  watchPluginThemes,
  type OfferedTheme,
  type PluginThemes,
  type ThemeRef,
} from '../theme/pluginThemes'
import { showPane } from './panes'

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
  return sentences([t('editorSettings.fontSizeHint'), keys])
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

const THEME_LABELS: Readonly<Record<ThemeChoice, MessageKey>> = {
  default: 'appearanceSettings.themeDefault',
  ivory: 'appearanceSettings.themeIvory',
  dawn: 'appearanceSettings.themeDawn',
  tide: 'appearanceSettings.themeTide',
  sage: 'appearanceSettings.themeSage',
  ember: 'appearanceSettings.themeEmber',
}

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
 * `data-theme-preview`, read by the generated tokens), with the wallpaper showing through it.
 */
function WindowThumb({ appearance, look }: { appearance: Appearance; look: ThemeLook }) {
  return (
    <span
      className="window-thumb"
      data-appearance-preview={appearance}
      data-theme-preview={themePreview(look.theme)}
      style={colorVariables(look.colors)}
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
function AutoThumb({ looks }: { looks: Readonly<Record<Appearance, ThemeLook>> }) {
  return (
    <span className="choice-thumb auto-thumb" aria-hidden="true">
      <span className="auto-thumb-light">
        <WindowThumb appearance="light" look={looks.light} />
      </span>
      <span className="auto-thumb-dark">
        <WindowThumb appearance="dark" look={looks.dark} />
      </span>
    </span>
  )
}

function ThemeSwatch({ appearance, look }: { appearance: Appearance; look: ThemeLook }) {
  return (
    <span
      className="swatch"
      data-appearance-preview={appearance}
      data-theme-preview={themePreview(look.theme)}
      style={colorVariables(look.colors)}
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

function usePluginThemes(): PluginThemes {
  const [themes, setThemes] = useState(NO_PLUGIN_THEMES)
  useEffect(() => {
    let asked = 0
    const load = () => {
      const request = ++asked
      listPluginThemes().then(
        (next) => {
          if (request === asked) setThemes(next)
        },
        () => console.warn('W_PLUGIN_THEMES_FAILED'),
      )
    }
    load()
    const stopThemes = watchPluginThemes(load)
    const stopPlugins = watchPlugins(load)
    return () => {
      asked++
      stopThemes()
      stopPlugins()
    }
  }, [])
  return themes
}

const MODES: readonly Appearance[] = ['light', 'dark']

const MODE_LABELS: Readonly<Record<Appearance, MessageKey>> = {
  light: 'appearanceSettings.lightMode',
  dark: 'appearanceSettings.darkMode',
}

const NO_MODE_LABELS: Readonly<Record<Appearance, MessageKey>> = {
  light: 'appearanceSettings.themeNoLight',
  dark: 'appearanceSettings.themeNoDark',
}

/** A theme's colors for one appearance, drawn on a swatch or thumbnail: a built-in theme, or a plugin's over Default. */
interface ThemeLook {
  theme: ThemeChoice
  colors?: Readonly<Record<string, string>> | undefined
}

const colorVariables = (colors: Readonly<Record<string, string>> | undefined) =>
  colors
    ? (Object.fromEntries(
        Object.entries(colors).map(([key, color]) => [`--color-${key}`, color]),
      ) as CSSProperties)
    : undefined

/** One appearance of a theme card: the swatch is that appearance's radio, and a plugin with several shows them as dots. */
interface ThemeHalf {
  look: ThemeLook
  checked: boolean
  choose: () => void
  /** A plugin theme's name without its plugin's, under the swatch. */
  caption?: string | undefined
  variants?: readonly {
    title: string
    colors: Readonly<Record<string, string>>
    shown: boolean
    choose: () => void
  }[]
}

interface ThemeCardModel {
  key: string
  name: string
  halves: Readonly<Record<Appearance, ThemeHalf | null>>
}

function ThemeCard({ card, group }: { card: ThemeCardModel; group: string }) {
  const chosenBoth = MODES.every((mode) => card.halves[mode]?.checked ?? true)
  const captioned = MODES.some((mode) => card.halves[mode]?.caption !== undefined)
  return (
    <div className={`theme-card${chosenBoth ? ' theme-card-chosen' : ''}`}>
      <div className="theme-card-halves">
        {MODES.map((mode) => {
          const half = card.halves[mode]
          if (!half) {
            return (
              <span key={mode} className="theme-half">
                <span className="swatch swatch-missing" aria-hidden="true">
                  {t(NO_MODE_LABELS[mode])}
                </span>
                {captioned ? <span className="theme-half-caption" aria-hidden="true" /> : null}
              </span>
            )
          }
          return (
            <span key={mode} className="theme-half">
              <label className="choice">
                <input
                  type="radio"
                  className="visually-hidden"
                  name={`${group}-${mode}`}
                  checked={half.checked}
                  onChange={half.choose}
                  aria-label={format(t('appearanceSettings.themeInMode'), {
                    theme: half.caption ? `${card.name} ${half.caption}` : card.name,
                    mode: t(MODE_LABELS[mode]),
                  })}
                />
                <span className="choice-frame">
                  <ThemeSwatch appearance={mode} look={half.look} />
                </span>
              </label>
              {captioned ? (
                <span className="theme-half-caption" aria-hidden="true">
                  {half.caption}
                </span>
              ) : null}
              {half.variants && half.variants.length > 1 ? (
                <span className="theme-variants">
                  {half.variants.map((variant) => (
                    <button
                      key={variant.title}
                      type="button"
                      className="theme-variant"
                      aria-pressed={variant.shown}
                      aria-label={format(t('appearanceSettings.themeInMode'), {
                        theme: variant.title,
                        mode: t(MODE_LABELS[mode]),
                      })}
                      style={colorVariables(variant.colors)}
                      onClick={variant.choose}
                    />
                  ))}
                </span>
              ) : null}
            </span>
          )
        })}
      </div>
      <button
        type="button"
        className="theme-card-name"
        aria-pressed={chosenBoth}
        onClick={() => {
          for (const mode of MODES) {
            const half = card.halves[mode]
            if (half && !half.checked) half.choose()
          }
        }}
      >
        {card.name}
      </button>
    </div>
  )
}

/** A plugin's themes for one appearance, the chosen one first shown. */
function pluginHalf(
  offered: readonly OfferedTheme[],
  chosen: ThemeRef | null,
  choose: (theme: OfferedTheme) => void,
): ThemeHalf | null {
  const first = offered[0]
  if (!first) return null
  const shown =
    offered.find((o) => chosen && o.plugin === chosen.plugin && o.id === chosen.theme) ?? first
  const caption = (title: string, plugin: string) =>
    title === plugin
      ? undefined
      : title.startsWith(`${plugin} `)
        ? title.slice(plugin.length + 1)
        : title
  return {
    look: { theme: 'default', colors: shown.colors },
    checked: chosen !== null && chosen.plugin === shown.plugin && chosen.theme === shown.id,
    choose: () => choose(shown),
    caption: caption(shown.title, shown.pluginName),
    variants: offered.map((o) => ({
      title: o.title,
      colors: o.colors,
      shown: o === shown,
      choose: () => choose(o),
    })),
  }
}

/**
 * Every theme as a card with its Light Mode and Dark Mode swatches: the built-in ones, then one per plugin that adds
 * themes (ADR 0026). A swatch chooses its theme for its appearance, the card's name for both; a plugin theme replaces
 * the appearance's built-in theme, so choosing one sets that appearance back to Default.
 */
function ThemeGallery({
  settings,
  change,
  pluginThemes,
  onFailure,
}: {
  settings: Readonly<Record<'lightTheme' | 'darkTheme', ThemeChoice>>
  change: (patch: Partial<Record<'lightTheme' | 'darkTheme', ThemeChoice>>) => void
  pluginThemes: PluginThemes
  onFailure: (code: string) => void
}) {
  const ids = useId()
  const settingOf = (mode: Appearance) => (mode === 'light' ? 'lightTheme' : 'darkTheme')
  const chooseBuiltIn = (mode: Appearance, theme: ThemeChoice) => {
    if (settings[settingOf(mode)] !== theme) change({ [settingOf(mode)]: theme })
    if (pluginThemes.chosen[mode]) {
      choosePluginTheme(mode, null).catch((error: unknown) => onFailure(errorCode(error)))
    }
  }
  const choosePlugin = (mode: Appearance, theme: OfferedTheme) => {
    choosePluginTheme(mode, { plugin: theme.plugin, theme: theme.id }).catch((error: unknown) =>
      onFailure(errorCode(error)),
    )
    if (settings[settingOf(mode)] !== 'default') change({ [settingOf(mode)]: 'default' })
  }
  const builtIn: ThemeCardModel[] = THEMES.map((theme) => ({
    key: theme,
    name: t(THEME_LABELS[theme]),
    halves: {
      light: {
        look: { theme },
        checked: !pluginThemes.chosen.light && settings.lightTheme === theme,
        choose: () => chooseBuiltIn('light', theme),
      },
      dark: {
        look: { theme },
        checked: !pluginThemes.chosen.dark && settings.darkTheme === theme,
        choose: () => chooseBuiltIn('dark', theme),
      },
    },
  }))
  const plugins = [...new Set(pluginThemes.themes.map((theme) => theme.plugin))]
  const fromPlugins: ThemeCardModel[] = plugins.map((plugin) => {
    const of = (mode: Appearance) =>
      pluginThemes.themes.filter((theme) => theme.plugin === plugin && theme.appearance === mode)
    const half = (mode: Appearance) =>
      pluginHalf(of(mode), pluginThemes.chosen[mode], (theme) => choosePlugin(mode, theme))
    return {
      key: plugin,
      name: pluginThemes.themes.find((theme) => theme.plugin === plugin)?.pluginName ?? plugin,
      halves: { light: half('light'), dark: half('dark') },
    }
  })
  return (
    <div className="theme-grid">
      {[...builtIn, ...fromPlugins].map((card) => (
        <ThemeCard key={card.key} card={card} group={ids} />
      ))}
      <button
        type="button"
        className="theme-card theme-card-more"
        onClick={() => showPane('plugins')}
      >
        <Icon name="settings.plugins" size="sm" />
        <span>{t('appearanceSettings.moreThemes')}</span>
      </button>
    </div>
  )
}

/**
 * Settings > Appearance: the color scheme (Auto, Light or Dark) and how see-through the window is;
 * a theme for each appearance, the one in effect marked Active (Ivory has its own accent, so the
 * system accent option is hidden while it is in effect), and the gradient's strength while either
 * is a gradient theme; whether things move; the icon style; and the editor's and preview's type.
 * Every change applies at once, and changes made elsewhere show here as they happen.
 */
export function AppearanceSection() {
  const settings = useEditorSettings()
  const shown = useAppearance()
  const [error, change] = useSettingsChange()
  const pluginThemes = usePluginThemes()
  const [pluginThemeError, setPluginThemeError] = useState<string>()
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
  const plain = useMemo(() => new Intl.NumberFormat(locale), [locale])
  const glassAmount = useDraggedNumber({
    stored: settings.windowTransparency,
    store: (windowTransparency) => change({ windowTransparency }),
  })
  const materialAmount = useDraggedNumber({
    stored: settings.materialTransparency,
    store: (materialTransparency) => change({ materialTransparency }),
  })
  const gradientAmount = useDraggedNumber({
    stored: settings.gradientStrength,
    store: (gradientStrength) => change({ gradientStrength }),
  })
  const lookOf = (mode: Appearance): ThemeLook => {
    const plugin = pluginThemeInEffect(pluginThemes, mode)
    return plugin
      ? { theme: 'default', colors: plugin.colors }
      : { theme: mode === 'light' ? settings.lightTheme : settings.darkTheme }
  }
  const looks = { light: lookOf('light'), dark: lookOf('dark') }
  const gradientShown = gradientThemeChosen(settings)

  return (
    <section className="settings-section" aria-labelledby="appearance-title">
      <h2 id="appearance-title" className="visually-hidden">
        {t('appearanceSettings.title')}
      </h2>
      {error || pluginThemeError ? (
        <p role="alert" className="settings-error">
          {failureText('appearanceSettings.failed', error ?? pluginThemeError ?? '')}
        </p>
      ) : null}
      <SettingsSection title="appearanceSettings.groupAppearance">
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
                    <AutoThumb looks={looks} />
                  ) : (
                    <span className="choice-thumb" aria-hidden="true">
                      <WindowThumb appearance={choice} look={looks[choice]} />
                    </span>
                  )}
                </Choice>
              ))}
            </div>
          </div>
        </div>
        <RangeSetting
          label="appearanceSettings.glassAmount"
          hint="appearanceSettings.glassAmountHint"
          id={id('glass')}
          amount={glassAmount}
          min={-WINDOW_TRANSPARENCY_MAX}
          max={WINDOW_TRANSPARENCY_MAX}
          formatValue={signed.format}
        />
        <RangeSetting
          label="appearanceSettings.materialAmount"
          hint="appearanceSettings.materialAmountHint"
          id={id('material')}
          amount={materialAmount}
          min={-WINDOW_TRANSPARENCY_MAX}
          max={WINDOW_TRANSPARENCY_MAX}
          formatValue={signed.format}
        />
        {themeFollowsSystemAccent(themeInEffect(settings, shown)) ? (
          <SettingToggle
            label="appearanceSettings.systemAccent"
            description="appearanceSettings.systemAccentHint"
            checked={settings.systemAccent}
            onChange={(checked) => change({ systemAccent: checked })}
          />
        ) : null}
      </SettingsSection>
      <SettingsSection
        title="appearanceSettings.themes"
        titleSuffix={t(
          shown === 'light'
            ? 'appearanceSettings.themesLightActive'
            : 'appearanceSettings.themesDarkActive',
        )}
        footnote={t('appearanceSettings.themesHint')}
      >
        <ThemeGallery
          settings={settings}
          change={change}
          pluginThemes={pluginThemes}
          onFailure={setPluginThemeError}
        />
      </SettingsSection>
      {gradientShown ? (
        <SettingsSection title="appearanceSettings.gradient" titleHidden>
          <RangeSetting
            label="appearanceSettings.gradient"
            hint="appearanceSettings.gradientHint"
            id={id('gradient')}
            amount={gradientAmount}
            min={0}
            max={GRADIENT_STRENGTH_MAX}
            formatValue={plain.format}
          />
        </SettingsSection>
      ) : null}
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
        <FontFamilySetting
          slot="note"
          label="editorSettings.noteFont"
          settings={settings}
          change={change}
          id={id}
        />
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

function RangeSetting({
  label,
  hint,
  id,
  amount,
  min,
  max,
  formatValue,
}: {
  label: MessageKey
  hint: MessageKey
  id: string
  amount: ReturnType<typeof useDraggedNumber>
  min: number
  max: number
  formatValue: (value: number) => string
}) {
  return (
    <Setting label={label} description={t(hint)} htmlFor={id} descriptionId={`${id}-hint`}>
      <span className="setting-range">
        <input
          id={id}
          type="range"
          className="slider"
          min={min}
          max={max}
          step={WINDOW_TRANSPARENCY_STEP}
          value={amount.value}
          style={{ '--value': amount.value, '--min': min, '--max': max } as CSSProperties}
          aria-describedby={`${id}-hint`}
          onChange={(e) => amount.drag(Number(e.currentTarget.value))}
          onPointerUp={amount.release}
          onKeyUp={amount.release}
          onBlur={amount.release}
        />
        <output className="setting-range-value" htmlFor={id}>
          {formatValue(amount.value)}
        </output>
      </span>
    </Setting>
  )
}
