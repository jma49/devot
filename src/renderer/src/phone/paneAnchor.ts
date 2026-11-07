import type { PaneAnchor } from './screens/settings'

// A pane draws most of its rows after its first reads; past this the owner is reading it already.
const ANCHOR_WAIT_MS = 2000

/**
 * Scrolls `container` to its `[data-anchor]` named `name` once it is drawn. Touching the pane
 * first, or the wait ending, leaves it where it is. Returns the cancel.
 */
export function revealAnchor(container: HTMLElement, name: PaneAnchor): () => void {
  const reveal = (): boolean => {
    const target = container.querySelector(`[data-anchor="${name}"]`)
    target?.scrollIntoView({ block: 'start' })
    return target !== null
  }
  if (reveal()) return () => {}
  const observer = new MutationObserver(() => {
    if (reveal()) stop()
  })
  const timer = setTimeout(() => stop(), ANCHOR_WAIT_MS)
  function stop() {
    observer.disconnect()
    clearTimeout(timer)
    container.removeEventListener('touchstart', stop)
  }
  observer.observe(container, { childList: true, subtree: true })
  container.addEventListener('touchstart', stop, { passive: true })
  return stop
}
