// The appearance a window shows (Settings > Appearance): the system's, or
// always light or dark. The setting is stored with the editor settings. A
// chosen appearance is `data-appearance` on the root element, which the
// generated tokens read (tokens.css); Rust also gives every window that
// theme, so the window's material and `prefers-color-scheme` follow it.
// Without one, the tokens follow `prefers-color-scheme`.
import type { AppearanceChoice } from '../../../core/editorSettings'
import { editorSettings, subscribeEditorSettings } from '../editorSettings'

export type Appearance = 'light' | 'dark'

export interface AppearanceTarget {
  dataset: Record<string, string | undefined>
}

/** Sent on the window after the chosen appearance changed. */
export const APPEARANCE_CHANGED = 'devot:appearance-changed'

const DARK = '(prefers-color-scheme: dark)'

/** Marks `root` with the chosen appearance; the system's leaves it unmarked. */
export function applyAppearance(choice: AppearanceChoice, root: AppearanceTarget): void {
  if (choice === 'system') delete root.dataset['appearance']
  else root.dataset['appearance'] = choice
}

const rootTarget = () => document.documentElement as unknown as AppearanceTarget

/** The appearance the page shows now: the chosen one, else the system's. */
export function shownAppearance(root: AppearanceTarget = rootTarget()): Appearance {
  const chosen = root.dataset['appearance']
  if (chosen === 'light' || chosen === 'dark') return chosen
  return matchMedia(DARK).matches ? 'dark' : 'light'
}

/** Calls `onChange` when the shown appearance may have changed. */
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
 * Shows the stored appearance and follows changes made in any window. Once
 * per page, after `startEditorSettings`.
 */
export function startAppearance(root: AppearanceTarget = rootTarget()): void {
  if (started) return
  started = true
  let shown = editorSettings().appearance
  applyAppearance(shown, root)
  subscribeEditorSettings(() => {
    const next = editorSettings().appearance
    if (next === shown) return
    shown = next
    applyAppearance(next, root)
    window.dispatchEvent(new Event(APPEARANCE_CHANGED))
  })
}
