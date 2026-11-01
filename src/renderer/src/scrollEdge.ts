export function isScrolled(scrollTop: number): boolean {
  return Number.isFinite(scrollTop) && scrollTop > 0
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
