// The sites whose images the user loaded while Settings > Preview > Load Images from the Web is
// off. Kept for this window's session only, so a restart asks again.
import { useSyncExternalStore } from 'react'
import { remoteImageHost } from '../../core/preview/remoteImages'

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

/** Whether an image at `url` waits for Load: only one from the web, from a site not loaded yet. */
export function remoteImageWaits(url: string, loadRemote: boolean): boolean {
  if (loadRemote) return false
  const host = remoteImageHost(url)
  return host !== null && !loaded.includes(host)
}

/** For tests: forgets every site, as a new session does. */
export function forgetLoadedImageHosts(): void {
  loaded = []
  for (const listener of listeners) listener()
}
