// Preview islands: the UI half of the preview extension API. A worker-side
// renderer marks an element `data-devot-island="<kind>"`; the island
// registered for that kind renders its content on the page, for features
// that need the page's layout engine (Mermaid measures text as it draws).
import { PREVIEW_API_VERSION } from '../../../core/preview/registry'
import type { Appearance } from '../icons/symbols'

/** The attribute a worker-side renderer puts on an element the page draws (preview/index.ts). */
export const ISLAND_ATTRIBUTE = 'data-devot-island'

export interface IslandContext {
  appearance: Appearance
  /** The theme on screen, when the appearance alone does not settle an island's colours. */
  theme?: string
  /** Aborted once a newer render for the same element starts, or the element goes. */
  signal?: AbortSignal | undefined
  /** The width the element has, for an island whose `followsWidth` says its drawing depends on it. */
  width?: number | undefined
  /** Where a drawing's stylesheet goes when the element is not in the document itself (the editor's shadow root). */
  styleRoot?: DocumentOrShadowRoot | undefined
}

export interface IslandContent {
  node: Node
  dispose?: () => void
  /**
   * The content stands in for a failure that may pass (not an error in the
   * source): the next mount renders the island again.
   */
  retry?: boolean
}

export interface PreviewIsland {
  kind: string
  apiVersion: typeof PREVIEW_API_VERSION
  /** This source's drawing depends on the element's width: it is drawn again when that changes. */
  followsWidth?(source: string): boolean
  render(source: string, context: IslandContext): Promise<IslandContent>
}

export interface IslandRegistry {
  register(island: PreviewIsland): () => void
  get(kind: string): PreviewIsland | undefined
}

export function createIslandRegistry(initial: readonly PreviewIsland[] = []): IslandRegistry {
  const islands = new Map<string, PreviewIsland>()
  const registry: IslandRegistry = {
    register(island) {
      if (island.apiVersion !== PREVIEW_API_VERSION) throw new Error('E_PREVIEW_API_VERSION')
      if (islands.has(island.kind)) throw new Error('E_PREVIEW_ISLAND_DUPLICATE')
      islands.set(island.kind, island)
      return () => {
        if (islands.get(island.kind) === island) islands.delete(island.kind)
      }
    },
    get: (kind) => islands.get(kind),
  }
  initial.forEach((island) => registry.register(island))
  return registry
}

const WIDTH_STEP = 40
const NARROWEST = 320
const RESIZE_SETTLE_MS = 150

/** Rounded down, so the drawing fits; the step stops a pane drag from drawing at every pixel. Below the floor it shrinks to fit. */
export function drawingWidth(available: number): number | undefined {
  if (available <= 0) return undefined
  return Math.max(NARROWEST, Math.floor(available / WIDTH_STEP) * WIDTH_STEP)
}

interface Slot {
  key: string
  /** What its drawn height depends on: the kind, width and source, not the colours. */
  sizeKey: string
  pending?: AbortController | undefined
  shown?: IslandContent | undefined
  retry: boolean
  /** Failures so far, and when the next try may start: a failure that may pass is not retried on every patch. */
  attempts: number
  retryAt: number
  width?: number | undefined
}

export interface IslandMounter {
  /**
   * Keeps every island in `host` rendered for its current source and
   * appearance; call it after each patch. The `rendered` given last runs
   * each time an island's content is put in place (the layout changed).
   */
  mount(host: Element, context: IslandContext, rendered?: () => void): void
  dispose(): void
}

const KNOWN_HEIGHTS = 500

/** The height each diagram was last drawn at, so a new element for it (or a preview opened again) reserves it. */
const knownHeights = new Map<string, number>()

function learnHeight(key: string, height: number): void {
  knownHeights.delete(key)
  knownHeights.set(key, height)
  if (knownHeights.size > KNOWN_HEIGHTS) knownHeights.delete(knownHeights.keys().next().value!)
}

const styleOf = (el: Element) => (el as Partial<ElementCSSInlineStyle>).style

interface Landed {
  el: Element
  slot: Slot
  content: IslandContent
  current: () => boolean
}

/**
 * With a `scroller`, an island renders only while it is within one screen of
 * the scroller's view, above or below it: a long note's diagrams cost
 * nothing until they are scrolled near. Drawings that land in the same frame
 * go in together; one that lands above the view moves the scroll position by
 * its growth, so what is in view stays put. A diagram drawn before keeps its
 * height reserved while it is drawn again.
 */
export function createIslandMounter(
  registry: IslandRegistry,
  { scroller }: { scroller?: (host: Element) => HTMLElement | null } = {},
): IslandMounter {
  const slots = new Map<Element, Slot>()
  const waiting = new Map<Element, () => void>()
  const near = new Set<Element>()
  const landed: Landed[] = []
  let onRendered: (() => void) | undefined
  let lastHost: Element | undefined
  let watched: HTMLElement | undefined
  let nearby: IntersectionObserver | undefined
  let frame: number | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryDue = 0
  let lastContext: IslandContext | undefined
  let settle: ReturnType<typeof setTimeout> | undefined
  const remount = () => {
    if (lastHost && lastContext) mount(lastHost, lastContext, onRendered)
  }
  let widths: ResizeObserver | undefined
  const widthObserver = () =>
    (widths ??= new ResizeObserver(() => {
      clearTimeout(settle)
      settle = setTimeout(remount, RESIZE_SETTLE_MS)
    }))

  const release = (slot: Slot) => {
    slot.pending?.abort()
    slot.pending = undefined
    slot.shown?.dispose?.()
    slot.shown = undefined
  }

  const shownView = () => {
    const root = lastHost && scroller?.(lastHost)
    return root && root.clientHeight > 0 ? root : undefined
  }
  const startWaiting = (el: Element) => {
    const start = waiting.get(el)
    if (!start || !shownView()) return
    waiting.delete(el)
    start()
  }
  const watch = () => {
    const root = lastHost && scroller?.(lastHost)
    if (!root || root === watched) return
    unwatch()
    watched = root
    nearby = new IntersectionObserver(
      (entries) => {
        for (const { target, isIntersecting } of entries) {
          if (!isIntersecting) {
            near.delete(target)
            continue
          }
          near.add(target)
          startWaiting(target)
        }
      },
      { root, rootMargin: '100% 0px' },
    )
    for (const el of slots.keys()) nearby.observe(el)
  }
  const unwatch = () => {
    nearby?.disconnect()
    nearby = undefined
    near.clear()
    watched = undefined
  }

  const put = ({ el, slot, content }: Landed) => {
    slot.pending = undefined
    slot.shown?.dispose?.()
    slot.shown = content
    const style = styleOf(el)
    if (style) style.minHeight = ''
    el.replaceChildren(content.node)
    if (content.retry === true) failed(slot)
    else {
      slot.retry = false
      slot.attempts = 0
      slot.retryAt = 0
    }
  }

  /** One frame's drawings, put in place with a layout read before and after, not one per drawing. */
  const placeLanded = () => {
    frame = undefined
    const batch = landed.splice(0).filter((entry) => {
      if (entry.current()) return true
      entry.content.dispose?.()
      return false
    })
    if (batch.length === 0) return
    const root = scroller && lastHost ? scroller(lastHost) : null
    const viewTop = root?.getBoundingClientRect().top
    const above = batch.flatMap((entry) => {
      if (viewTop === undefined) return []
      const box = entry.el.getBoundingClientRect()
      return box.bottom <= viewTop ? [{ el: entry.el, before: box.height }] : []
    })
    batch.forEach(put)
    const grown = above.reduce(
      (sum, { el, before }) => sum + el.getBoundingClientRect().height - before,
      0,
    )
    if (root && grown !== 0) root.scrollTop += grown
    for (const { el, slot } of batch) {
      const height = el.getBoundingClientRect().height
      if (height > 0) learnHeight(slot.sizeKey, height)
    }
    onRendered?.()
  }

  /** Waits out the shortest backoff of a failure that may pass, then mounts again. */
  const arm = () => {
    const now = Date.now()
    let soonest = Number.POSITIVE_INFINITY
    for (const [el, slot] of slots) {
      if (!slot.retry || !el.isConnected) continue
      soonest = Math.min(soonest, slot.retryAt)
    }
    if (soonest === Number.POSITIVE_INFINITY) return
    if (retryTimer !== undefined) {
      if (retryDue <= soonest) return
      clearTimeout(retryTimer)
    }
    retryDue = soonest
    retryTimer = setTimeout(
      () => {
        retryTimer = undefined
        remount()
      },
      Math.max(0, soonest - now),
    )
  }

  /** A failure that may pass is tried again later, each try waiting longer. */
  const failed = (slot: Slot) => {
    slot.retry = true
    slot.attempts += 1
    slot.retryAt = Date.now() + Math.min(30_000, 500 * 2 ** (slot.attempts - 1))
    arm()
  }

  const render = (
    el: Element,
    slot: Slot,
    island: PreviewIsland,
    source: string,
    context: IslandContext,
    width: number | undefined,
  ) => {
    const request = slot.pending
    const current = () => slots.get(el) === slot && slot.pending === request
    island.render(source, { ...context, signal: request?.signal, width }).then(
      (content) => {
        // A newer render for this element won the race, or the element
        // is gone: drop this one.
        if (!current()) return content.dispose?.()
        if (!scroller) {
          put({ el, slot, content, current })
          onRendered?.()
          return
        }
        landed.push({ el, slot, content, current })
        frame ??= requestAnimationFrame(placeLanded)
      },
      () => {
        if (current()) {
          slot.pending = undefined
          failed(slot)
        }
        console.warn('W_PREVIEW_ISLAND_FAILED', island.kind)
      },
    )
  }

  const mount = (host: Element, context: IslandContext, rendered?: () => void) => {
    onRendered = rendered
    lastHost = host
    lastContext = context
    if (scroller) watch()
    for (const [el, slot] of slots) {
      // An element that is no island any more (its block became a plain
      // div) gives its slot up: its drawing must not stay there.
      if (!el.isConnected || !el.hasAttribute(ISLAND_ATTRIBUTE)) {
        release(slot)
        slots.delete(el)
        waiting.delete(el)
        near.delete(el)
        nearby?.unobserve(el)
        widths?.unobserve(el)
      }
    }
    for (const el of host.querySelectorAll(`[${ISLAND_ATTRIBUTE}]`)) {
      const kind = el.getAttribute(ISLAND_ATTRIBUTE) ?? ''
      const source = el.getAttribute('data-island-source') ?? ''
      const island = registry.get(kind)
      const known = slots.get(el)
      const follows = island?.followsWidth?.(source) === true
      // A pane that is hidden has no width: what is drawn stays until it is shown.
      const width = follows ? (drawingWidth(el.clientWidth) ?? known?.width) : undefined
      const key = `${context.appearance}\n${context.theme ?? ''}\n${width ?? ''}\n${source}`
      // A failure that may pass waits out its backoff; a source that changed
      // starts over at once.
      if (known?.key === key && (!known.retry || known.retryAt > Date.now())) continue
      if (!island) continue
      const slot: Slot = known ?? { key, sizeKey: '', retry: false, attempts: 0, retryAt: 0 }
      slot.width = width
      slot.sizeKey = `${kind}\n${width ?? ''}\n${source}`
      if (follows) widthObserver().observe(el)
      else widths?.unobserve(el)
      if (slot.key !== key) {
        slot.key = key
        slot.attempts = 0
        slot.retryAt = 0
      }
      slots.set(el, slot)
      slot.retry = false
      slot.pending?.abort()
      slot.pending = new AbortController()
      if (!scroller) {
        render(el, slot, island, source, context, width)
        continue
      }
      const reserved = slot.shown ? undefined : knownHeights.get(slot.sizeKey)
      const style = styleOf(el)
      if (reserved !== undefined && style) style.minHeight = `${reserved}px`
      waiting.set(el, () => render(el, slot, island, source, context, width))
      nearby?.observe(el)
      if (near.has(el)) startWaiting(el)
    }
    arm()
  }

  return {
    mount,
    dispose() {
      for (const slot of slots.values()) release(slot)
      for (const { content } of landed.splice(0)) content.dispose?.()
      slots.clear()
      waiting.clear()
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = undefined
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      retryTimer = undefined
      unwatch()
      clearTimeout(settle)
      widths?.disconnect()
    },
  }
}
