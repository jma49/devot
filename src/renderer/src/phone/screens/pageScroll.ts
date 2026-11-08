/**
 * The shown note scrolls the page itself, so UIKit's bars follow the web view's own scroll view
 * (spike S4); false keeps the note's own scroller, the fallback.
 */
export const NOTE_PAGE_SCROLLS = true

const FOOT_INSET = '--editor-foot-inset'

/** While the native editor shows a note, the page's height is the note's. */
export function pageScrolls(on: boolean): void {
  document.documentElement.toggleAttribute('data-page-scrolls', on)
}

/** Room the keyboard and the formatting bar take at the foot, which the editor's scroll margins keep the caret above (editor/settings.ts). */
export function setFootInset(bottom: number): void {
  const root = document.documentElement
  if (bottom > 0) root.style.setProperty(FOOT_INSET, `${bottom}px`)
  else root.style.removeProperty(FOOT_INSET)
}
