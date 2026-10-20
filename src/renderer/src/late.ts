import { useLayoutEffect, type RefObject } from 'react'

/** How long a note may take to load before its body shows as loading. */
export const BODY_PLACEHOLDER_MS = 150

/**
 * Sets `attribute` on the element once `on` has held for `ms`, and takes it off in the commit `on` turns false.
 * Set on the element, not through state, so a slow switch does not render the window again.
 */
export function useLateAttribute(
  element: RefObject<HTMLElement | null>,
  attribute: string,
  on: boolean,
  ms: number,
): void {
  useLayoutEffect(() => {
    const el = element.current
    if (!on || !el) return
    const timer = setTimeout(() => el.setAttribute(attribute, ''), ms)
    return () => {
      clearTimeout(timer)
      el.removeAttribute(attribute)
    }
  }, [element, attribute, on, ms])
}
