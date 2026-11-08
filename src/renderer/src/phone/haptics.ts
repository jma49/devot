export type HapticKind = 'light' | 'soft' | 'selection' | 'success' | 'warning'

let sink: ((kind: HapticKind) => void) | null = null

/** The native screens play the page's haptics (`editor.haptic`); the web fallback plays none. */
export function routeHaptics(to: ((kind: HapticKind) => void) | null): void {
  sink = to
}

export function haptic(kind: HapticKind): void {
  sink?.(kind)
}
