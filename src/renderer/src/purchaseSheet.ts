// Whether an App Store build's purchase sheet is open: Buy opens it from any surface, and the
// phone shows it over every tab.
import { useSyncExternalStore } from 'react'

let open = false
let gate = false
const listeners = new Set<() => void>()

const set = (nextOpen: boolean, nextGate: boolean) => {
  if (open === nextOpen && gate === nextGate) return
  open = nextOpen
  gate = nextGate
  for (const listener of listeners) listener()
}

/** `gate`: a write that editing is locked for opened it (phone/requireEditing.ts). */
export const openPurchase = (options: { gate?: boolean } = {}): void =>
  set(true, options.gate ?? false)
export const closePurchase = (): void => set(false, false)
export const purchaseOpen = (): boolean => open
export const purchaseGate = (): boolean => open && gate

export function subscribePurchase(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePurchaseOpen(): boolean {
  return useSyncExternalStore(subscribePurchase, purchaseOpen)
}

export function usePurchaseGate(): boolean {
  return useSyncExternalStore(subscribePurchase, purchaseGate)
}
