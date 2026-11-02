import { useSyncExternalStore } from 'react'

export type PhoneInterface = 'glass' | 'classic'

export interface GlassPrefs {
  readonly style: PhoneInterface
  /** -100 is solid, 0 the design, 100 twice as clear. */
  readonly transparency: number
}

// This device's own keys in the webview's storage: never the Mac's interface style or window transparency, and never synced.
export const STYLE_KEY = 'devot.phone.interfaceStyle'
export const TRANSPARENCY_KEY = 'devot.phone.glassTransparency'
export const TRANSPARENCY_MAX = 100
export const TRANSPARENCY_STEP = 5

export function readGlassPrefs(style: string | null, transparency: string | null): GlassPrefs {
  const amount = transparency === null ? 0 : Number(transparency)
  return {
    style: style === 'classic' ? 'classic' : 'glass',
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

const storage = () => globalThis.localStorage as Storage | undefined

const load = (): GlassPrefs =>
  readGlassPrefs(
    storage()?.getItem(STYLE_KEY) ?? null,
    storage()?.getItem(TRANSPARENCY_KEY) ?? null,
  )

let current = load()
const listeners = new Set<() => void>()

function apply(): void {
  const root = document.documentElement
  if (current.style === 'classic') root.dataset['phoneGlass'] = 'classic'
  else delete root.dataset['phoneGlass']
  root.style.setProperty('--phone-glass-surface', glassSurface(current.transparency))
}

export function setGlassPrefs(patch: Partial<GlassPrefs>): void {
  current = { ...current, ...patch }
  storage()?.setItem(STYLE_KEY, current.style)
  storage()?.setItem(TRANSPARENCY_KEY, String(current.transparency))
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
