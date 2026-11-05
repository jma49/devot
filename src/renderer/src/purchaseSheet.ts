// Whether an App Store build's purchase sheet is open: Buy opens it from any surface, and the
// phone shows it over every tab.
import { useSyncExternalStore } from 'react'

let open = false
const listeners = new Set<() => void>()

const set = (next: boolean) => {
  if (open === next) return
  open = next
  for (const listener of listeners) listener()
}

export const openPurchase = (): void => set(true)
export const closePurchase = (): void => set(false)
export const purchaseOpen = (): boolean => open

export function subscribePurchase(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePurchaseOpen(): boolean {
  return useSyncExternalStore(subscribePurchase, purchaseOpen)
}
