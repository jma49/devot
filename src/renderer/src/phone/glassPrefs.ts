import { useSyncExternalStore } from 'react'
import { localStore } from '../localStore'

export interface GlassPrefs {
  /** -100 is solid, 0 the design, 100 twice as clear. */
  readonly transparency: number
}

// This device's own key in the webview's storage: never the Mac's window transparency, and never synced.
const TRANSPARENCY_KEY = 'devot.phone.glassTransparency'
export const TRANSPARENCY_MAX = 100
export const TRANSPARENCY_STEP = 5

export function readGlassPrefs(transparency: string | null): GlassPrefs {
  const amount = transparency === null ? 0 : Number(transparency)
  return {
    transparency: Number.isFinite(amount)
      ? Math.max(-TRANSPARENCY_MAX, Math.min(TRANSPARENCY_MAX, Math.round(amount)))
      : 0,
  }
}

/** The glass's fill: the design's tint, mixed towards its opaque colour or thinned to half its opacity. */
export function glassSurface(transparency: number): string {
  if (transparency === 0) return 'var(--color-phone-glass)'
  return transparency < 0
    ? `color-mix(in srgb, var(--color-phone-glass-opaque) ${-transparency}%, var(--color-phone-glass))`
    : `color-mix(in srgb, var(--color-phone-glass) ${100 - transparency / 2}%, transparent)`
}

const stored = () => localStore()?.getItem(TRANSPARENCY_KEY) ?? null
const load = (): GlassPrefs => readGlassPrefs(stored())

/** The value this page kept, for the native store's one-time migration; null when it kept none. */
export function storedGlassTransparency(): number | null {
  const value = stored()
  return value === null ? null : readGlassPrefs(value).transparency
}

let current = load()
const listeners = new Set<() => void>()

function apply(): void {
  document.documentElement.style.setProperty(
    '--phone-glass-surface',
    glassSurface(current.transparency),
  )
}

export function setGlassPrefs(patch: Partial<GlassPrefs>): void {
  current = { ...current, ...patch }
  localStore()?.setItem(TRANSPARENCY_KEY, String(current.transparency))
  apply()
  for (const listener of listeners) listener()
}

/** Puts the stored choice on the page; the phone root calls it once. */
export const applyGlassPrefs = apply

export const useGlassPrefs = (): GlassPrefs =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => current,
  )
