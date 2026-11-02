import { invoke } from '../ipc'

export type HapticKind = 'light' | 'soft' | 'selection' | 'success'

/** Plays a haptic on the iPhone; Rust does nothing on the Mac. A failure is only logged. */
export function haptic(kind: HapticKind): void {
  void invoke('haptic', { kind }).catch(() => console.warn('W_PHONE_HAPTIC_FAILED'))
}
