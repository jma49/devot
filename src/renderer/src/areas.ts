// The keyboard moves between the window's three areas: the sidebar, the
// note list and the editor (with the open note's title and toolbar). Tab and
// Shift+Tab do it on a sidebar row or in the list (`view.*AreaInPane`);
// Control+Tab and Control+Shift+Tab anywhere (`view.*Area`), since in the
// editor Tab indents and moves between table cells. Escape then Tab (or
// Shift+Tab) in the editor works too: CodeMirror leaves the next Tab alone
// for two seconds after Escape, and it moves on like a pane's Tab.
import { useEffect, useRef } from 'react'
import { sheetOpen } from './commands/dispatch'
import { commandMatches } from './commands/registry'
import { isImeKey } from './ime'

export type Area = 'sidebar' | 'list' | 'editor'

const ORDER: readonly Area[] = ['sidebar', 'list', 'editor']

/**
 * The area after (`1`) or before (`-1`) `from`, round the window, skipping
 * areas not `shown` (hidden, or with nothing to focus); from outside the
 * areas, the first (or last) one shown. None when no other area shows.
 */
export function nextArea(
  from: Area | undefined,
  step: 1 | -1,
  shown: (area: Area) => boolean,
): Area | undefined {
  const at = from === undefined ? (step > 0 ? -1 : ORDER.length) : ORDER.indexOf(from)
  for (let i = 1; i <= ORDER.length; i++) {
    const area = ORDER[(at + step * i + ORDER.length * 2) % ORDER.length]!
    if (area === from) return undefined
    if (shown(area)) return area
  }
  return undefined
}

/** The area an element is in, if any. */
export function areaOf(element: Element | null): Area | undefined {
  const part = element?.closest('[data-devot-part="sidebar"], [data-devot-part="list"], main')
  if (!part) return undefined
  if (part.matches('[data-devot-part="sidebar"]')) return 'sidebar'
  return part.matches('[data-devot-part="list"]') ? 'list' : 'editor'
}

/** Whether an element is in the page and shown. */
export const visible = (el: HTMLElement | null): el is HTMLElement =>
  el !== null && el.isConnected && el.offsetParent !== null

/**
 * What takes the keyboard in each area: the sidebar's row that is its tab
 * stop; the list's (its open note's or first row, else the list itself); in
 * the editor area the note's text (once the editor has loaded, `editor`),
 * else the rendered note (Preview mode, the Trash), which scrolls with the
 * keys, else the title, else the first button of the note. Undefined for an
 * area with none shown.
 */
export function areaTargets(
  editor: { focus: () => void } | null,
): Record<Area, (() => void) | undefined> {
  const one = (selector: string) => {
    const el = document.querySelector<HTMLElement>(selector)
    return visible(el) ? () => el.focus() : undefined
  }
  const body = document.querySelector<HTMLElement>('[data-devot-part="editor-body"]')
  return {
    sidebar: one('[data-devot-part="sidebar"] [data-sidebar-row][tabindex="0"]'),
    list:
      one('[data-devot-part="list"] [role="option"][tabindex="0"]') ??
      one('[data-devot-part="list"] [role="listbox"]'),
    editor:
      (editor && visible(body) && !body.hidden ? () => editor.focus() : undefined) ??
      one('main [data-devot-part="preview"]') ??
      one('main input.title') ??
      one('main > :not([data-devot-part="toolbar"]) button:not(:disabled)'),
  }
}

/**
 * The pane a Tab key press came from, if it should move to another area: a
 * sidebar row, the note list or one of its rows, or the editor's text when
 * the editor left the key alone (after Escape).
 */
function paneOf(e: KeyboardEvent): Area | undefined {
  const target = e.composedPath()[0]
  if (!(target instanceof Element)) return undefined
  if (target.matches('[data-devot-part="sidebar"] [data-sidebar-row]')) return 'sidebar'
  if (target.closest('[data-devot-part="list"] [role="listbox"]')) return 'list'
  return target.matches('.cm-content') ? 'editor' : undefined
}

/**
 * Tab and Shift+Tab in a pane (see `paneOf`) move the keyboard to the next
 * or previous area (`move`), unless something there took the key first or
 * an input method used it (the editor leaves a Tab that ended a composition
 * alone).
 */
export function usePaneTab(move: (step: 1 | -1, from: Area) => void) {
  const latest = useRef(move)
  useEffect(() => {
    latest.current = move
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isImeKey(e) || sheetOpen()) return
      const step = commandMatches('view.nextAreaInPane', e)
        ? 1
        : commandMatches('view.previousAreaInPane', e)
          ? -1
          : 0
      const from = step === 0 ? undefined : paneOf(e)
      if (!step || !from) return
      e.preventDefault()
      latest.current(step, from)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
