// The licence in a window (src-tauri/src/licence). Rust checks the key, keeps it in the keychain,
// runs the three-day trial and, without a valid licence once the trial is over, refuses every write
// of user content, sync and AI; windows read its state (never the key) to show what is locked. After every change Rust sends `devot://licence-changed` with the state to every window,
// which re-sends it in the page as `devot:licence-changed` (the UI tests send that one).
import { useSyncExternalStore } from 'react'
import {
  createEntitlements,
  LICENCE_STATES,
  TRIAL_STATES,
  type Entitlements,
  type LicenceState,
  type TrialState,
} from '../../core/entitlements'
import { invoke } from './ipc'

export const LICENCE_CHANGED = 'devot:licence-changed'
/** What Rust and the core refuse sync and AI with when the licence does not include them. */
export const LICENCE_REQUIRED = 'E_LICENCE_REQUIRED'
const CHANGED_EVENT = 'devot://licence-changed'

/** The one place the licence pages' address is kept. */
export const LICENCE_SITE = 'https://licence.devot.online'
export const BUY_URL = `${LICENCE_SITE}/buy`

export interface TrialSnapshot {
  state: TrialState
  /** Milliseconds since the epoch; null when the trial could not be read. */
  endsAt: number | null
  code: string | null
}

export interface LicenceSnapshot {
  /** Whether this build needs a licence or the trial for editing, sync and AI at all. */
  gated: boolean
  state: LicenceState
  code: string | null
  id: string | null
  licensee: string | null
  plan: 'pro' | null
  /** Null while the build gates nothing. */
  trial: TrialSnapshot | null
}

/** Until Rust answers, nothing shows as locked: Rust refuses on its own when it must. */
export const LICENCE_UNKNOWN: LicenceSnapshot = {
  gated: false,
  state: 'none',
  code: null,
  id: null,
  licensee: null,
  plan: null,
  trial: null,
}

const CODE = /^[EWI]_[A-Z0-9_]+$/
const LICENCE_ID = /^[A-Za-z0-9_-]{22}$/

export const isLicenceId = (value: unknown): value is string =>
  typeof value === 'string' && LICENCE_ID.test(value)
export const isLicenceState = (value: unknown): value is LicenceState =>
  typeof value === 'string' && (LICENCE_STATES as readonly string[]).includes(value)

const isTrialState = (value: unknown): value is TrialState =>
  typeof value === 'string' && (TRIAL_STATES as readonly string[]).includes(value)

function readTrial(value: unknown): TrialSnapshot | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (!isTrialState(v['state'])) return null
  const endsAt = v['endsAt']
  return {
    state: v['state'],
    endsAt: typeof endsAt === 'number' && Number.isSafeInteger(endsAt) ? endsAt : null,
    code: typeof v['code'] === 'string' && CODE.test(v['code']) ? v['code'] : null,
  }
}

/** Whether the trial runs at `now`: Rust says so, and its end has not come yet in this window. */
export function trialRunning(licence: LicenceSnapshot, now: number): boolean {
  const trial = licence.trial
  return trial?.state === 'running' && (trial.endsAt === null || now < trial.endsAt)
}

/** Whether the end of the trial is why editing, sync and AI are locked. */
export function trialOver(licence: LicenceSnapshot, now: number): boolean {
  return licence.gated && licence.state !== 'valid' && !trialRunning(licence, now)
}

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
    // A build that gates is never without a trial: one Rust did not describe counts as ended.
    trial: v['gated']
      ? (readTrial(v['trial']) ?? { state: 'ended', endsAt: null, code: null })
      : null,
  }
}

let snapshot = LICENCE_UNKNOWN
const listeners = new Set<() => void>()
let trialEnd: ReturnType<typeof setTimeout> | undefined
/** The longest delay a timer takes; a later end is looked at again then. */
const MAX_DELAY_MS = 2 ** 31 - 1

const notify = () => {
  for (const listener of listeners) listener()
}

/** Tells the windows when the trial ends; Rust's own look at the trial comes within a minute. */
const watchTrialEnd = (endsAt: number) => {
  const left = endsAt - Date.now()
  if (left <= 0) return
  trialEnd = setTimeout(
    () => {
      if (left > MAX_DELAY_MS) watchTrialEnd(endsAt)
      else {
        snapshot = { ...snapshot }
        notify()
      }
    },
    Math.min(left, MAX_DELAY_MS),
  )
}

const publish = (next: LicenceSnapshot | undefined) => {
  if (!next) return
  snapshot = next
  clearTimeout(trialEnd)
  if (next.trial?.state === 'running' && next.trial.endsAt !== null)
    watchTrialEnd(next.trial.endsAt)
  notify()
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
    read: () => ({
      enforced: snapshot.gated,
      state: snapshot.state,
      plan: snapshot.plan,
      trial: trialRunning(snapshot, Date.now()) ? 'running' : 'ended',
    }),
  },
})

/** Re-renders when the trial ends or a licence or the trial's state changes. */
export function useTrialOver(): boolean {
  return useSyncExternalStore(subscribeLicence, () => trialOver(snapshot, Date.now()))
}

/** Whether notes may be changed in this window now. */
export const editingAllowed = (): boolean => licenceEntitlements.has('editing')

/** Re-renders when editing is allowed or stops being, the trial's end included. */
export function useEditing(): boolean {
  return useSyncExternalStore(subscribeLicence, editingAllowed)
}

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

/** Add Licence: Settings, at the Licence pane. */
export const openLicenceSettings = () =>
  void invoke('settings_open_licence').catch(() => console.warn('W_SETTINGS_OPEN_FAILED'))
