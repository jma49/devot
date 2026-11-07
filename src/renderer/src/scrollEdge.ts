import { sizes as tokenSizes } from './theme/tokens'

const FADE_DEPTH = Number.parseFloat(tokenSizes['size.scroll-edge'])
const SCROLLED_BY = '--scrolled-by'

export function isScrolled(scrollTop: number): boolean {
  return Number.isFinite(scrollTop) && scrollTop > 0
}

/** How far a pane has scrolled, up to the fade's full depth, as a CSS length: its top edge fades no deeper than that, so text just under the top is not faded before it reaches the edge. */
export function scrolledBy(scrollTop: number): string {
  const depth = isScrolled(scrollTop) ? Math.min(scrollTop, FADE_DEPTH) : 0
  return `${Math.round(depth * 100) / 100}px`
}

/** Sets the `--scrolled-by` a pane's fade reads, only when it changes: past the fade depth a scroll touches no style. */
export function showScrolledBy(pane: ElementCSSInlineStyle, scrollTop: number) {
  const value = scrolledBy(scrollTop)
  if (pane.style.getPropertyValue(SCROLLED_BY) !== value) pane.style.setProperty(SCROLLED_BY, value)
}

export function hideScrolledBy(pane: ElementCSSInlineStyle) {
  pane.style.removeProperty(SCROLLED_BY)
}

interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

// A zoomed or fractional layout can leave under a pixel of scrollTop short of the end.
const END_SLOP = 1

export function scrollEdges({ scrollTop, scrollHeight, clientHeight }: ScrollMetrics) {
  return {
    above: isScrolled(scrollTop),
    below: scrollHeight - clientHeight - scrollTop > END_SLOP,
  }
}

/** Keeps `data-scrolled` and `data-more-below` on a scroller true as it scrolls, resizes or its content changes. */
export function watchScrollEdges(scroller: HTMLElement): () => void {
  const update = () => {
    const { above, below } = scrollEdges(scroller)
    scroller.toggleAttribute('data-scrolled', above)
    scroller.toggleAttribute('data-more-below', below)
  }
  // Observing the children too catches a section's height animating open, which fires no scroll.
  const sizes = new ResizeObserver(update)
  const observeSizes = () => {
    sizes.disconnect()
    sizes.observe(scroller)
    for (const child of scroller.children) sizes.observe(child)
  }
  const children = new MutationObserver(observeSizes)
  children.observe(scroller, { childList: true })
  scroller.addEventListener('scroll', update, { passive: true })
  observeSizes()
  update()
  return () => {
    scroller.removeEventListener('scroll', update)
    children.disconnect()
    sizes.disconnect()
  }
}
