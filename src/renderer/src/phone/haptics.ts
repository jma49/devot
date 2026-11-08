import { invoke } from '../ipc'

export type HapticKind = 'light' | 'soft' | 'selection' | 'success' | 'warning'

let sink: ((kind: HapticKind) => void) | null = null

/** Under the native screens Swift plays the page's haptics (`editor.haptic`); null hands them back to Rust. */
export function routeHaptics(to: ((kind: HapticKind) => void) | null): void {
  sink = to
}

/** Plays a haptic on the iPhone; Rust does nothing on the Mac. A failure is only logged. */
export function haptic(kind: HapticKind): void {
  if (sink) return sink(kind)
  void invoke('haptic', { kind }).catch(() => console.warn('W_PHONE_HAPTIC_FAILED'))
}
