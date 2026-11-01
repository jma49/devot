// The appearance and theme a window shows (Settings > Appearance). The
// appearance is the system's, or always light or dark; each appearance has its
// own theme, Devot's default or a built-in one such as Ivory. All are stored
// with the editor settings. A chosen appearance is `data-appearance` on the
// root element and the theme for the appearance that shows is `data-theme`;
// the generated tokens read them (tokens.css). Rust also gives every window
// the appearance, so the window's material and `prefers-color-scheme` follow
// it. Without one, the tokens follow `prefers-color-scheme`.
import {
  themeInEffect,
  type AppearanceChoice,
  type EditorSettings,
  type ThemeChoice,
} from '../../../core/editorSettings'
import { editorSettings, subscribeEditorSettings } from '../editorSettings'

export type Appearance = 'light' | 'dark'

export interface AppearanceTarget {
  dataset: Record<string, string | undefined>
}

export const APPEARANCE_CHANGED = 'devot:appearance-changed'

const DARK = '(prefers-color-scheme: dark)'

export function applyAppearance(choice: AppearanceChoice, root: AppearanceTarget): void {
  if (choice === 'system') delete root.dataset['appearance']
  else root.dataset['appearance'] = choice
}

export function applyTheme(choice: ThemeChoice, root: AppearanceTarget): void {
  if (choice === 'default') delete root.dataset['theme']
  else root.dataset['theme'] = choice
}

const rootTarget = () => document.documentElement as unknown as AppearanceTarget

export function shownAppearance(root: AppearanceTarget = rootTarget()): Appearance {
  const chosen = root.dataset['appearance']
  if (chosen === 'light' || chosen === 'dark') return chosen
  return matchMedia(DARK).matches ? 'dark' : 'light'
}

/** Marks the root with the chosen appearance, then with the theme chosen for the appearance that shows. */
export function applyAppearanceSettings(
  settings: Pick<EditorSettings, 'appearance' | 'lightTheme' | 'darkTheme'>,
  root: AppearanceTarget,
): void {
  applyAppearance(settings.appearance, root)
  applyTheme(themeInEffect(settings, shownAppearance(root)), root)
}

export function subscribeAppearance(onChange: () => void): () => void {
  const query = matchMedia(DARK)
  query.addEventListener('change', onChange)
  window.addEventListener(APPEARANCE_CHANGED, onChange)
  return () => {
    query.removeEventListener('change', onChange)
    window.removeEventListener(APPEARANCE_CHANGED, onChange)
  }
}

let started = false

/**
 * Shows the stored appearance and theme and follows changes made in any
 * window, and the system's appearance while the window follows it. Once per
 * page, after `startEditorSettings`.
 */
export function startAppearance(root: AppearanceTarget = rootTarget()): void {
  if (started) return
  started = true
  applyAppearanceSettings(editorSettings(), root)
  const palette = () =>
    `${root.dataset['appearance']}/${root.dataset['theme']}/${shownAppearance(root)}`
  let current = palette()
  const follow = () => {
    applyAppearanceSettings(editorSettings(), root)
    const next = palette()
    if (next !== current) {
      current = next
      root.dataset['appearanceChanging'] = ''
      // Finish the new palette before WKWebView resumes a background window's compositor.
      void document.documentElement.offsetHeight
      requestAnimationFrame(() => delete root.dataset['appearanceChanging'])
      window.dispatchEvent(new Event(APPEARANCE_CHANGED))
    }
  }
  subscribeEditorSettings(follow)
  matchMedia(DARK).addEventListener('change', follow)
}
