// The licence in a window (src-tauri/src/licence). Rust checks the key, keeps it in the keychain and
// refuses sync and AI without a valid one; windows read its state (never the key) to show what is
// locked. After every change Rust sends `devot://licence-changed` with the state to every window,
// which re-sends it in the page as `devot:licence-changed` (the UI tests send that one).
import { useSyncExternalStore } from 'react'
import {
  createEntitlements,
  LICENCE_STATES,
  type Entitlements,
  type LicenceState,
} from '../../core/entitlements'
import { invoke } from './ipc'

export const LICENCE_CHANGED = 'devot:licence-changed'
/** What Rust and the core refuse sync and AI with when the licence does not include them. */
export const LICENCE_REQUIRED = 'E_LICENCE_REQUIRED'
const CHANGED_EVENT = 'devot://licence-changed'

/** The one place the licence pages' address is kept. */
export const LICENCE_SITE = 'https://licence.devot.online'
export const BUY_URL = `${LICENCE_SITE}/buy`

export interface LicenceSnapshot {
  /** Whether this build needs a licence for sync and AI at all. */
  gated: boolean
  state: LicenceState
  code: string | null
  id: string | null
  licensee: string | null
  plan: 'pro' | null
}

/** Until Rust answers, nothing shows as locked: Rust refuses on its own when it must. */
export const LICENCE_UNKNOWN: LicenceSnapshot = {
  gated: false,
  state: 'none',
  code: null,
  id: null,
  licensee: null,
  plan: null,
}

const CODE = /^[EWI]_[A-Z0-9_]+$/
const LICENCE_ID = /^[A-Za-z0-9_-]{22}$/

export const isLicenceId = (value: unknown): value is string =>
  typeof value === 'string' && LICENCE_ID.test(value)
export const isLicenceState = (value: unknown): value is LicenceState =>
  typeof value === 'string' && (LICENCE_STATES as readonly string[]).includes(value)

export function readLicence(value: unknown): LicenceSnapshot | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (typeof v['gated'] !== 'boolean' || !isLicenceState(v['state'])) return undefined
  return {
    gated: v['gated'],
    state: v['state'],
    code: typeof v['code'] === 'string' && CODE.test(v['code']) ? v['code'] : null,
    id: isLicenceId(v['id']) ? v['id'] : null,
    licensee: typeof v['licensee'] === 'string' && v['licensee'] !== '' ? v['licensee'] : null,
    plan: v['plan'] === 'pro' ? 'pro' : null,
  }
}

let snapshot = LICENCE_UNKNOWN
const listeners = new Set<() => void>()
const publish = (next: LicenceSnapshot | undefined) => {
  if (!next) return
  snapshot = next
  for (const listener of listeners) listener()
}

let started = false

/** Reads the state and follows Rust's changes; once per window. */
export function startLicence(): void {
  if (started) return
  started = true
  window.addEventListener(LICENCE_CHANGED, (e) => publish(readLicence((e as CustomEvent).detail)))
  invoke<unknown>('licence_get').then(
    (value) => publish(readLicence(value)),
    () => console.warn('W_LICENCE_READ_FAILED'),
  )
  if (!DEVOT_UI_TEST) {
    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<unknown>(CHANGED_EVENT, (e) =>
          window.dispatchEvent(new CustomEvent(LICENCE_CHANGED, { detail: e.payload })),
        ),
      )
      .catch(() => console.warn('W_LICENCE_LISTEN_FAILED'))
  }
}

export const licenceSnapshot = (): LicenceSnapshot => snapshot

/** Asks Rust again, for a decision that must not rest on a state that may be stale. */
export async function readCurrentLicence(): Promise<LicenceSnapshot> {
  const next = readLicence(await invoke<unknown>('licence_get'))
  publish(next)
  return next ?? snapshot
}

export function subscribeLicence(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useLicence(): LicenceSnapshot {
  return useSyncExternalStore(subscribeLicence, () => snapshot)
}

/** What the window may offer, from the state Rust reported last. */
export const licenceEntitlements: Entitlements = createEntitlements({
  source: {
    read: () => ({ enforced: snapshot.gated, state: snapshot.state, plan: snapshot.plan }),
  },
})

/** Rejects with Rust's code (E_LICENCE_MALFORMED, E_LICENCE_SIGNATURE, ...); nothing changes then. */
export async function addLicence(key: string): Promise<LicenceSnapshot> {
  const next = readLicence(await invoke<unknown>('licence_set', { key }))
  publish(next)
  return next ?? snapshot
}

export async function removeLicence(): Promise<LicenceSnapshot> {
  const next = readLicence(await invoke<unknown>('licence_remove'))
  publish(next)
  return next ?? snapshot
}

const open = (url: string) =>
  void invoke('open_external', { url }).catch(() => console.warn('W_OPEN_EXTERNAL_FAILED'))

export const openBuy = () => open(BUY_URL)
