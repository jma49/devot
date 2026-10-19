// Preview islands: the UI half of the preview extension API. A worker-side
// renderer marks an element `data-devot-island="<kind>"`; the island
// registered for that kind renders its content on the page, for features
// that need the page's layout engine (Mermaid measures text as it draws).
import { PREVIEW_API_VERSION } from '../../../core/preview/registry'
import type { Appearance } from '../icons/symbols'

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
        slot.retry = content.retry === true
        el.replaceChildren(content.node)
        onRendered?.()
        schedule()
      },
      () => {
        if (current()) {
          slot.pending = undefined
          slot.retry = true
        }
        console.warn('W_PREVIEW_ISLAND_FAILED', island.kind)
      },
    )
  }

  return {
    mount(host, context, rendered) {
      onRendered = rendered
      lastHost = host
      for (const [el, slot] of slots) {
        if (!el.isConnected) {
          release(slot)
          slots.delete(el)
          waiting.delete(el)
        }
      }
      for (const el of host.querySelectorAll('[data-devot-island]')) {
        const kind = el.getAttribute('data-devot-island') ?? ''
        const source = el.getAttribute('data-island-source') ?? ''
        const key = `${context.appearance}\n${source}`
        const known = slots.get(el)
        if (known?.key === key && !known.retry) continue
        const island = registry.get(kind)
        if (!island) continue
        const slot: Slot = known ?? { key, retry: false }
        slots.set(el, slot)
        slot.key = key
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
    },
    dispose() {
      for (const slot of slots.values()) release(slot)
      slots.clear()
      waiting.clear()
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = undefined
      unwatch()
    },
  }
}
