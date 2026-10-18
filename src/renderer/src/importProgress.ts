// How far each running import scan has got. Rust reports it up to ten
// times a second; it lives here rather than in App state, so only the
// import sheet that shows it renders again.
import { useSyncExternalStore } from 'react'

export interface ScanFound {
  files: number
  images: number
}

const NONE: ScanFound = { files: 0, images: 0 }
const found = new Map<number, ScanFound>()
const listeners = new Set<() => void>()

/** What scan `id` has found so far (nothing yet, or no scan: zero). */
export const scanFound = (id: number | null): ScanFound =>
  (id === null ? undefined : found.get(id)) ?? NONE

export function setScanFound(id: number, counts: ScanFound): void {
  found.set(id, counts)
  for (const listener of listeners) listener()
}

/** Drops what scan `id` found, once its sheet has closed. */
export function forgetScanFound(id: number): void {
  found.delete(id)
}

export function subscribeScanFound(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** What scan `id` has found so far, kept up to date. */
export function useScanFound(id: number | null): ScanFound {
  return useSyncExternalStore(subscribeScanFound, () => scanFound(id))
}
