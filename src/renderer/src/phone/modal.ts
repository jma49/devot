/** What `holdModal` needs of an element: the DOM's, or a stand-in in tests. */
export interface ModalNode {
  readonly parentElement: ModalNode | null
  readonly children: ArrayLike<object>
  inert: boolean
}

// Only HTML elements can be inert; an SVG sibling is left as it is.
const canBeInert = (node: object): node is ModalNode => 'inert' in node

const layers: ModalNode[] = []
const madeInert = new Set<ModalNode>()
const watchers = new Set<() => void>()

// Only the top layer and its ancestors stay live; a sheet under it is a sibling, so it is inert too.
function sync(): void {
  for (const node of madeInert) node.inert = false
  madeInert.clear()
  const top = layers.at(-1)
  for (let node = top; node?.parentElement; node = node.parentElement) {
    for (const sibling of Array.from(node.parentElement.children)) {
      if (sibling === node || !canBeInert(sibling) || sibling.inert) continue
      sibling.inert = true
      madeInert.add(sibling)
    }
  }
}

/**
 * Makes everything but `layer` inert until the returned release is called. Layers stack: the
 * last held is the live one, and releasing it gives the one under it back.
 */
export function holdModal(layer: ModalNode): () => void {
  layers.push(layer)
  sync()
  if (layers.length === 1) for (const watcher of watchers) watcher()
  return () => {
    const at = layers.lastIndexOf(layer)
    if (at === -1) return
    layers.splice(at, 1)
    sync()
    if (layers.length === 0) for (const watcher of watchers) watcher()
  }
}

export const modalOpen = (): boolean => layers.length > 0

/** Calls `watcher` when the first layer is held and when the last is released. */
export function watchModals(watcher: () => void): () => void {
  watchers.add(watcher)
  return () => void watchers.delete(watcher)
}

export const isTopModal = (layer: ModalNode): boolean => layers.at(-1) === layer
