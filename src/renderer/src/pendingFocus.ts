import { useEffect, useState } from 'react'
import { useStable } from './stable'

/** A note the list, board or gallery has asked to give the keyboard to before its element has rendered. */
export type FocusIntent = { kind: 'none' } | { kind: 'pending'; id: string; view: string }

const NONE: FocusIntent = { kind: 'none' }

interface Options {
  view: string
  /** Whether the view's order holds the note: a request for any other is dropped at once. */
  listed: (id: string) => boolean
  element: (id: string) => HTMLElement | undefined
  /** The element that holds the rows or cards; focus on a listbox in it keeps the request. */
  container: () => HTMLElement | null
  /** Gives the note's element the keyboard once it has rendered. */
  take: (el: HTMLElement) => void
}

/**
 * A focus request for a note whose element has not rendered yet (a long list
 * renders it first). It expires when the keyboard goes anywhere else, the
 * view changes or the note leaves the order, so it never takes the keyboard
 * back from where the user moved it. `revealed` is the note to render meanwhile.
 */
export function usePendingFocus(options: Options): {
  request: (id: string) => void
  revealed: string | undefined
} {
  const { view, listed, element, take } = options
  const [intent, setIntent] = useState<FocusIntent>(NONE)
  const request = (id: string) => setIntent(listed(id) ? { kind: 'pending', id, view } : NONE)
  const stale = intent.kind === 'pending' && (intent.view !== view || !listed(intent.id))
  // Dropped during the render that shows it stale, as React allows for a component's own state.
  if (stale) setIntent(NONE)
  const live = stale ? NONE : intent

  // The note's element taking the keyboard ends the request (the focusin below).
  useEffect(() => {
    const el = live.kind === 'pending' ? element(live.id) : undefined
    if (el) take(el)
  })

  const container = useStable(options.container)
  useEffect(() => {
    // The keyboard on the listbox itself (the window's focus rescue) still
    // waits for the row; on a note's element or outside, the request is done.
    const onFocusIn = (e: FocusEvent) => {
      const to = e.target
      const listbox = to instanceof Element && to.getAttribute('role') === 'listbox'
      if (!listbox || !container()?.contains(to)) setIntent(NONE)
    }
    // Focus that falls to the page from an element still shown left on purpose
    // (a click on blank space); a removed row's focus is what the request replaces.
    const onFocusOut = (e: FocusEvent) => {
      const from = e.target
      if (e.relatedTarget !== null || !(from instanceof Node)) return
      queueMicrotask(() => {
        const active = document.activeElement
        if ((!active || active === document.body) && from.isConnected) setIntent(NONE)
      })
    }
    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('focusout', onFocusOut, true)
    return () => {
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('focusout', onFocusOut, true)
    }
  }, [container])

  return { request, revealed: live.kind === 'pending' ? live.id : undefined }
}
