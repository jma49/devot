// Plugin themes (ADR 0026): the colors of the plugin theme chosen for the appearance that shows, set on the root element
// over the theme chosen in Settings > Appearance. Only color tokens this build knows are set, so a theme written for a
// later build still draws what this one has.
import { isRecord } from '../../../core/isRecord'
import { invoke } from '../ipc'
import { watchPlugins } from '../plugins/api'
import { unlistenLater } from '../windowEvents'
import { shownAppearance, subscribeAppearance, type Appearance } from './appearance'
import { light } from './tokens'

export interface ThemeRef {
  plugin: string
  theme: string
}

export interface OfferedTheme {
  plugin: string
  pluginName: string
  id: string
  title: string
  appearance: Appearance
  colors: Readonly<Record<string, string>>
}

export interface PluginThemes {
  themes: readonly OfferedTheme[]
  chosen: { light: ThemeRef | null; dark: ThemeRef | null }
}

export const NO_PLUGIN_THEMES: PluginThemes = { themes: [], chosen: { light: null, dark: null } }

/** Each color token as a theme file names it: its CSS variable after `--color-`. */
export const THEME_COLORS: ReadonlySet<string> = new Set(
  Object.keys(light).map((k) => k.slice('color.'.length).replaceAll('.', '-')),
)

const COLOR = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/
const CHANGED = 'devot:plugin-themes-changed'
const CHANGED_TAURI = 'devot://plugin-themes-changed'

const isRef = (value: unknown): value is ThemeRef =>
  isRecord(value) && typeof value['plugin'] === 'string' && typeof value['theme'] === 'string'

function readTheme(value: unknown): OfferedTheme | undefined {
  if (!isRecord(value)) return undefined
  const { plugin, pluginName, id, title, appearance, colors } = value
  if (
    typeof plugin !== 'string' ||
    typeof pluginName !== 'string' ||
    typeof id !== 'string' ||
    typeof title !== 'string' ||
    (appearance !== 'light' && appearance !== 'dark') ||
    !isRecord(colors)
  )
    return undefined
  const known: Record<string, string> = {}
  for (const [key, color] of Object.entries(colors)) {
    if (THEME_COLORS.has(key) && typeof color === 'string' && COLOR.test(color)) known[key] = color
  }
  return { plugin, pluginName, id, title, appearance, colors: known }
}

/** Read again here, as every answer from Rust is; what does not fit is left out. */
export function readPluginThemes(value: unknown): PluginThemes {
  if (!isRecord(value) || !Array.isArray(value['themes']) || !isRecord(value['chosen'])) {
    return NO_PLUGIN_THEMES
  }
  const themes = value['themes'].flatMap((t) => readTheme(t) ?? [])
  const pick = (appearance: Appearance): ThemeRef | null => {
    const ref = (value['chosen'] as Record<string, unknown>)[appearance]
    return isRef(ref) &&
      themes.some(
        (t) => t.plugin === ref.plugin && t.id === ref.theme && t.appearance === appearance,
      )
      ? { plugin: ref.plugin, theme: ref.theme }
      : null
  }
  return { themes, chosen: { light: pick('light'), dark: pick('dark') } }
}

export const themeInEffect = (themes: PluginThemes, appearance: Appearance) => {
  const ref = themes.chosen[appearance]
  return ref ? themes.themes.find((t) => t.plugin === ref.plugin && t.id === ref.theme) : undefined
}

export interface ThemeTarget {
  dataset: Record<string, string | undefined>
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): void }
}

/** Sets the theme's colors on `root` and takes off the ones set before that it does not set; returns what is set now. */
export function applyPluginTheme(
  theme: OfferedTheme | undefined,
  root: ThemeTarget,
  before: ReadonlySet<string>,
): Set<string> {
  const now = new Set(Object.keys(theme?.colors ?? {}).map((key) => `--color-${key}`))
  for (const name of before) if (!now.has(name)) root.style.removeProperty(name)
  for (const [key, color] of Object.entries(theme?.colors ?? {})) {
    root.style.setProperty(`--color-${key}`, color)
  }
  if (theme) root.dataset['pluginTheme'] = `${theme.plugin}/${theme.id}`
  else delete root.dataset['pluginTheme']
  return now
}

export const listPluginThemes = () => invoke<unknown>('plugin_themes').then(readPluginThemes)

export const choosePluginTheme = (appearance: Appearance, theme: ThemeRef | null) =>
  invoke<null>('plugin_theme_choose', { appearance, theme }).then(() => undefined)

/** Calls `onChange` when a plugin theme is chosen in any window. */
export function watchPluginThemes(onChange: () => void): () => void {
  window.addEventListener(CHANGED, onChange)
  const unlisten = DEVOT_UI_TEST
    ? undefined
    : unlistenLater(
        import('@tauri-apps/api/event').then(({ listen }) =>
          listen(CHANGED_TAURI, () => window.dispatchEvent(new CustomEvent(CHANGED))),
        ),
        () => console.warn('W_PLUGIN_THEMES_LISTEN_FAILED'),
      )
  return () => {
    window.removeEventListener(CHANGED, onChange)
    unlisten?.()
  }
}

let started = false

/** Draws the chosen plugin theme and follows choices, plugins turned on or off, and the appearance. Once per page. */
export function startPluginThemes(
  root: ThemeTarget = document.documentElement as unknown as ThemeTarget,
): void {
  if (started) return
  started = true
  let themes = NO_PLUGIN_THEMES
  let applied: Set<string> = new Set()
  let asked = 0
  const apply = () => {
    applied = applyPluginTheme(themeInEffect(themes, shownAppearance(root)), root, applied)
  }
  const load = () => {
    const request = ++asked
    listPluginThemes().then(
      (next) => {
        if (request !== asked) return
        themes = next
        apply()
      },
      () => console.warn('W_PLUGIN_THEMES_FAILED'),
    )
  }
  load()
  watchPluginThemes(load)
  watchPlugins(load)
  subscribeAppearance(apply)
}
