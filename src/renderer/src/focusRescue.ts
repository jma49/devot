// The keyboard never falls to the page. When the element that has it is
// removed, hidden or disabled (a row deleted, a button that goes away with
// its action, an area hidden by Focus Mode, a sheet that closes), the web
// view drops focus on <body> and keys stop reaching the window. This hook
// notices that and moves the keyboard to the nearest sensible element:
//
// - a sidebar row: the same row if it is still there (moved, renamed), else
//   the next one (the one before it at the end);
// - anything else: the note list, else the editor area, else the sidebar
//   (the sidebar first when it was the sidebar that lost it).
//
// It acts only on focus that was lost this way. Focus the user moved away on
// purpose (a click on blank space, a blur) leaves the element it left in
// place and is not touched, and nothing happens while another element has
// the keyboard or a sheet is open (sheets give the keyboard back themselves,
// see sheet.ts; the hook covers what they cannot).
import { useEffect, useRef } from 'react'
import { sheetOpen } from './commands/dispatch'
import { areaOf, areaTargets, type Area } from './areas'

interface Last {
  element: Element
  area: Area | undefined
  rows?: { order: readonly string[]; at: string }
}

/**
 * Where the keyboard may go when the sidebar row `at` is gone: the row
 * itself (it may only have moved), then its own kind of row (notebooks,
 * statuses, tags) after it and before it, nearest first, then any other row
 * the same way.
 */
export function rowCandidates(order: readonly string[], at: string): string[] {
  const i = order.indexOf(at)
  if (i < 0) return [...order]
  const kind = (key: string) => key.split(':')[0]
  const after = order.slice(i + 1)
  const before = order.slice(0, i).reverse()
  const same = (key: string) => kind(key) === kind(at)
  return [
    at,
    ...after.filter(same),
    ...before.filter(same),
    ...after.filter((key) => !same(key)),
    ...before.filter((key) => !same(key)),
  ]
}

const SIDEBAR_ROWS = '[data-devot-part="sidebar"] [data-sidebar-row]'

function shown(el: Element): boolean {
  if (!el.isConnected || el.closest('[inert]')) return false
  const visibility = (el as { checkVisibility?: (o: object) => boolean }).checkVisibility
  return visibility
    ? visibility.call(el, { visibilityProperty: true })
    : el.getClientRects().length > 0
}

const usable = (el: Element) => shown(el) && !el.matches(':disabled')

function rowElement(key: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>(SIDEBAR_ROWS)).find(
    (el) => el.dataset['sidebarRow'] === key,
  )
}

/** `editor` gives the open editor, for the editor area's target (`areaTargets`). */
export function useFocusRescue(editor: () => { focus: () => void } | null): void {
  const latest = useRef(editor)
  useEffect(() => {
    latest.current = editor
  })
  useEffect(() => {
    let last: Last | undefined
    // The keyboard is in a sheet; it was somewhere else (`last`) before.
    let inSheet = false
    // Attributes changed since the last look: the focused element may be hidden.
    let changed = false
    let frame = 0

    const onFocusIn = (e: FocusEvent) => {
      // At the document an event from the editor's shadow root names its host.
      const target = e.target
      if (!(target instanceof Element)) return
      inSheet = target.closest('dialog') !== null
      if (inSheet) return
      const area = areaOf(target)
      const row = target.closest<HTMLElement>(SIDEBAR_ROWS)?.dataset['sidebarRow']
      // A field inside the sidebar (a name being edited) keeps the row it came from.
      let rows = area === 'sidebar' && last?.area === 'sidebar' ? last.rows : undefined
      if (row !== undefined) {
        const order = Array.from(
          document.querySelectorAll<HTMLElement>(SIDEBAR_ROWS),
          (r) => r.dataset['sidebarRow'] ?? '',
        )
        rows = { order, at: row }
      }
      last = { element: target, area, ...(rows ? { rows } : {}) }
    }

    const rescue = (from: Last) => {
      if (from.rows) {
        for (const key of rowCandidates(from.rows.order, from.rows.at)) {
          const el = rowElement(key)
          if (el && usable(el)) return el.focus()
        }
      }
      const targets = areaTargets(latest.current())
      const order: Area[] =
        from.area === 'sidebar'
          ? ['sidebar', 'list', 'editor']
          : from.area === 'history'
            ? ['editor', 'list', 'sidebar']
            : ['list', 'editor', 'sidebar']
      order.map((area) => targets[area]).find((target) => target !== undefined)?.()
    }

    const check = () => {
      frame = 0
      const hidden = changed
      changed = false
      if (sheetOpen()) return
      const wasInSheet = inSheet
      inSheet = false
      const active = document.activeElement
      const nowhere = active === null || active === document.body
      const from = last
      if (!from) {
        if (wasInSheet && nowhere) rescue({ element: document.body, area: undefined })
        return
      }
      const element = from.element
      if (!nowhere) {
        if (active !== element || (element.isConnected && !hidden)) return
      }
      if (usable(element)) {
        // On the page and usable: the user's own blur, unless a sheet that
        // had the keyboard closed without giving it back.
        if (nowhere && wasInSheet && element instanceof HTMLElement) element.focus()
        return
      }
      last = undefined
      rescue(from)
    }

    const schedule = () => {
      if (frame || (!last && !inSheet)) return
      // Two frames on: React has rendered and run the components' own effects,
      // so the keyboard is only taken in hand when nobody did. Passive effects
      // can still come later on a loaded machine: a component that moves the
      // keyboard itself when its element goes (the note list's next row) does
      // it in a layout effect, in the same commit.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(check)
      })
    }

    const observer = new MutationObserver((records) => {
      if (records.some((r) => r.type === 'attributes')) changed = true
      schedule()
    })
    // Focus that leaves for nowhere: removal fires nothing in every web view,
    // so the observer below covers that.
    const onFocusOut = (e: FocusEvent) => {
      if (e.relatedTarget === null) schedule()
    }
    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('focusout', onFocusOut, true)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'disabled', 'style', 'class', 'data-focus', 'inert', 'open'],
    })
    return () => {
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('focusout', onFocusOut, true)
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])
}
