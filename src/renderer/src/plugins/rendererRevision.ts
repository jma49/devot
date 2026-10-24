// Tells an open preview when plugins' preview renderers changed in the worker, so it renders again with them.
const listeners = new Set<() => void>()

export function pluginRenderersChanged(): void {
  for (const listener of listeners) listener()
}

export function onPluginRenderersChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
