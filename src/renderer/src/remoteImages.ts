// The sites whose images the user loaded while Settings > Preview > Load Images from the Web is
// off. Kept for this window's session only, so a restart asks again.
import { useSyncExternalStore } from 'react'

let loaded: readonly string[] = []
const listeners = new Set<() => void>()

export function loadedImageHosts(): readonly string[] {
  return loaded
}

export function loadImagesFrom(host: string): void {
  if (loaded.includes(host)) return
  loaded = [...loaded, host]
  for (const listener of listeners) listener()
}

export function onLoadedImageHosts(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const useLoadedImageHosts = (): readonly string[] =>
  useSyncExternalStore(onLoadedImageHosts, loadedImageHosts)

/** For tests: forgets every site, as a new session does. */
export function forgetLoadedImageHosts(): void {
  loaded = []
  for (const listener of listeners) listener()
}
