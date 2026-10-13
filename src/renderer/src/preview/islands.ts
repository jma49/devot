// Preview islands: the UI half of the preview extension API. A worker-side
// renderer marks an element `data-devot-island="<kind>"`; the island
// registered for that kind renders its content on the page, for features
// that need the page's layout engine (Mermaid measures text as it draws).
import { PREVIEW_API_VERSION } from '../../../core/preview/registry'
import type { Appearance } from '../icons/symbols'

export interface IslandContext {
  appearance: Appearance
}

export interface IslandContent {
  node: Node
  /** Frees what the content holds outside the node (stylesheets). */
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
  /** Builds the content for `source`; loads its library on first use. */
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

/** What the mounter knows about one island element. */
interface Slot {
  key: string
  /** The newest render asked for, until it lands. */
  pending?: object | undefined
  /** The content in the element, freed when it is replaced or removed. */
  shown?: IslandContent | undefined
  /** The shown content asked to be rendered again (see `IslandContent.retry`). */
  retry: boolean
}

export interface IslandMounter {
  /**
   * Keeps every island in `host` rendered for its current source and
   * appearance; call it after each patch. The `rendered` given last runs
   * each time an island's content is put in place (the layout changed).
   */
  mount(host: Element, context: IslandContext, rendered?: () => void): void
  /** Frees all content, including renders still on their way; mount starts over. */
  dispose(): void
}

export function createIslandMounter(registry: IslandRegistry): IslandMounter {
  const slots = new Map<Element, Slot>()
  let onRendered: (() => void) | undefined

  const release = (slot: Slot) => {
    slot.pending = undefined
    slot.shown?.dispose?.()
    slot.shown = undefined
  }

  return {
    mount(host, context, rendered) {
      onRendered = rendered
      for (const [el, slot] of slots) {
        if (!el.isConnected) {
          release(slot)
          slots.delete(el)
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
        const request = {}
        slot.pending = request
        const current = () => slots.get(el) === slot && slot.pending === request
        island.render(source, context).then(
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
          },
          () => {
            if (current()) {
              slot.pending = undefined
              slot.retry = true
            }
            console.warn('W_PREVIEW_ISLAND_FAILED', kind)
          },
        )
      }
    },
    dispose() {
      for (const slot of slots.values()) release(slot)
      slots.clear()
    },
  }
}
