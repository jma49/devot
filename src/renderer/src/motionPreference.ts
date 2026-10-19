// Whether the windows animate: Settings > Appearance > Motion's Animations
// choice (always, as the system's Reduce Motion asks, or never), shown on the
// root as `data-motion` ("full" or "reduced"). Every reduced-motion rule reads
// it: app.css by `:root[data-motion='reduced']`, the code by `motionReduced()`.
import type { AnimationsChoice } from '../../core/editorSettings'
import { editorSettings, subscribeEditorSettings } from './editorSettings'

const REDUCE = '(prefers-reduced-motion: reduce)'

/** Whether motion is reduced for `choice`, with the system asking for it or not. */
export const reducesMotion = (choice: AnimationsChoice, systemReduces: boolean): boolean =>
  choice === 'off' || (choice === 'system' && systemReduces)

/** What a root shows motion by. */
export interface MotionTarget {
  dataset: DOMStringMap
}

/** Shows `reduced` on `root`. */
export function applyMotion(reduced: boolean, root: MotionTarget): void {
  root.dataset['motion'] = reduced ? 'reduced' : 'full'
}

/** Whether the page's motion is reduced now (a page that never started motion animates). */
export const motionReduced = (): boolean =>
  typeof document !== 'undefined' && document.documentElement.dataset['motion'] === 'reduced'

let started = false

/**
 * Shows the stored Animations choice and follows it, and the system's Reduce
 * Motion, as either changes. Once per page, after `startEditorSettings`.
 */
export function startMotion(root: MotionTarget = document.documentElement): void {
  if (started) return
  started = true
  const query = typeof matchMedia === 'function' ? matchMedia(REDUCE) : null
  const show = () =>
    applyMotion(reducesMotion(editorSettings().animations, query?.matches ?? false), root)
  show()
  query?.addEventListener('change', show)
  subscribeEditorSettings(show)
}
