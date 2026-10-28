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
  /** Aborted once a newer render for the same element starts, or the element goes. */
  signal?: AbortSignal | undefined
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

interface Slot {
  key: string
  pending?: AbortController | undefined
  shown?: IslandContent | undefined
  retry: boolean
  /** Failures so far, and when the next try may start: a failure that may pass is not retried on every patch. */
  attempts: number
  retryAt: number
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

/**
 * With a `scroller`, an island renders only once it is above the bottom of
 * the scroller's view plus one more screen: content below the view costs
 * nothing until it is scrolled near, and content above it is always drawn,
 * so what is in view never moves because something above it drew late.
 */
export function createIslandMounter(
  registry: IslandRegistry,
  { scroller }: { scroller?: (host: Element) => HTMLElement | null } = {},
): IslandMounter {
  const slots = new Map<Element, Slot>()
  const waiting = new Map<Element, () => void>()
  let onRendered: (() => void) | undefined
  let lastHost: Element | undefined
  let watched: HTMLElement | undefined
  let frame: number | undefined
  let sizes: ResizeObserver | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let lastContext: IslandContext | undefined

  const release = (slot: Slot) => {
    slot.pending?.abort()
    slot.pending = undefined
    slot.shown?.dispose?.()
    slot.shown = undefined
  }

  const startNear = () => {
    frame = undefined
    const root = lastHost && scroller?.(lastHost)
    if (!root || root.clientHeight === 0) return
    const limit = root.getBoundingClientRect().bottom + root.clientHeight
    for (const [el, start] of waiting) {
      if (!el.isConnected) {
        waiting.delete(el)
        continue
      }
      if (el.getBoundingClientRect().top > limit) continue
      waiting.delete(el)
      start()
    }
  }
  const schedule = () => {
    if (frame === undefined && waiting.size > 0) frame = requestAnimationFrame(startNear)
  }
  const watch = () => {
    const root = lastHost && scroller?.(lastHost)
    if (!root || root === watched) return
    unwatch()
    watched = root
    root.addEventListener('scroll', schedule, { passive: true })
    root.addEventListener('load', schedule, true)
    sizes = new ResizeObserver(schedule)
    sizes.observe(root)
  }
  const unwatch = () => {
    watched?.removeEventListener('scroll', schedule)
    watched?.removeEventListener('load', schedule, true)
    sizes?.disconnect()
    watched = undefined
  }

  /** Waits out the shortest backoff of a failure that may pass, then mounts again. */
  const arm = () => {
    if (retryTimer !== undefined) return
    const now = Date.now()
    let soonest = Number.POSITIVE_INFINITY
    for (const [el, slot] of slots) {
      if (!slot.retry || !el.isConnected) continue
      soonest = Math.min(soonest, slot.retryAt)
    }
    if (soonest === Number.POSITIVE_INFINITY) return
    retryTimer = setTimeout(
      () => {
        retryTimer = undefined
        if (lastHost && lastContext) mount(lastHost, lastContext, onRendered)
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
  ) => {
    const request = slot.pending
    const current = () => slots.get(el) === slot && slot.pending === request
    island.render(source, { ...context, signal: request?.signal }).then(
      (content) => {
        // A newer render for this element won the race, or the element
        // is gone: drop this one.
        if (!current()) return content.dispose?.()
        slot.pending = undefined
        slot.shown?.dispose?.()
        slot.shown = content
        el.replaceChildren(content.node)
        if (content.retry === true) failed(slot)
        else {
          slot.retry = false
          slot.attempts = 0
          slot.retryAt = 0
        }
        onRendered?.()
        schedule()
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
    for (const [el, slot] of slots) {
      // An element that is no island any more (its block became a plain
      // div) gives its slot up: its drawing must not stay there.
      if (!el.isConnected || !el.hasAttribute(ISLAND_ATTRIBUTE)) {
        release(slot)
        slots.delete(el)
        waiting.delete(el)
      }
    }
    for (const el of host.querySelectorAll(`[${ISLAND_ATTRIBUTE}]`)) {
      const kind = el.getAttribute(ISLAND_ATTRIBUTE) ?? ''
      const source = el.getAttribute('data-island-source') ?? ''
      const key = `${context.appearance}\n${source}`
      const known = slots.get(el)
      // A failure that may pass waits out its backoff; a source that changed
      // starts over at once.
      if (known?.key === key && (!known.retry || known.retryAt > Date.now())) continue
      const island = registry.get(kind)
      if (!island) continue
      const slot: Slot = known ?? { key, retry: false, attempts: 0, retryAt: 0 }
      if (slot.key !== key) {
        slot.key = key
        slot.attempts = 0
        slot.retryAt = 0
      }
      slots.set(el, slot)
      slot.retry = false
      slot.pending?.abort()
      slot.pending = new AbortController()
      if (scroller) waiting.set(el, () => render(el, slot, island, source, context))
      else render(el, slot, island, source, context)
    }
    if (scroller) {
      watch()
      schedule()
    }
    arm()
  }

  return {
    mount,
    dispose() {
      for (const slot of slots.values()) release(slot)
      slots.clear()
      waiting.clear()
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = undefined
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      retryTimer = undefined
      unwatch()
    },
  }
}
