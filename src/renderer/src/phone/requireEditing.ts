// The one gate every write the phone offers goes through while editing may be locked. It decides
// from the licence snapshot it holds, never by trying the write; Rust still refuses on its own.
import { useEffect, useSyncExternalStore } from 'react'
import { errorCode } from '../../../core/errors'
import {
  editingAllowed,
  LICENCE_REQUIRED,
  LICENCE_UNREADABLE,
  licenceSnapshot,
  readCurrentLicence,
  soldOnAppStore,
  subscribeLicence,
  useEditing,
  type LicenceSnapshot,
} from '../licence'
import {
  closePurchase,
  openPurchase,
  purchaseGate,
  purchaseOpen,
  subscribePurchase,
} from '../purchaseSheet'
import { haptic } from './haptics'

export type WriteOp =
  | 'newNote'
  | 'newNotebook'
  | 'trash'
  | 'complete'
  | 'pin'
  | 'status'
  | 'move'
  | 'tags'
  | 'title'
  | 'edit'
  | 'task'
  | 'ai'

/** What the user asked for: the action and the note or notebook it is for, never any text. */
export interface WriteIntent {
  readonly op: WriteOp
  readonly id: string | null
}

export type ProSheetKind = 'checking' | 'key' | 'attention' | 'seat' | 'unreadable'

/** An App Store build that needs a purchase gets the purchase sheet; every other lock, the short Pro sheet. */
export type LockSurface =
  | { readonly kind: 'purchase' }
  | { readonly kind: 'pro'; readonly sheet: ProSheetKind }

export interface ProSheetState {
  readonly sheet: ProSheetKind
  readonly ai: boolean
}

const INTENT_MS = 10 * 60 * 1000

const keychainUnreadable = (licence: LicenceSnapshot): boolean =>
  [licence.code, licence.trial?.code].some(
    (code) => code === LICENCE_UNREADABLE || code?.startsWith('E_LICENCE_KEYCHAIN') === true,
  )

const seatMissing = (licence: LicenceSnapshot): boolean =>
  licence.state === 'valid' &&
  (licence.activation?.state === 'required' || licence.activation?.state === 'expired')

/** Which surface a locked licence shows a write. */
export function lockSurface(licence: LicenceSnapshot): LockSurface {
  const pro = (sheet: ProSheetKind): LockSurface => ({ kind: 'pro', sheet })
  if (keychainUnreadable(licence)) return pro('unreadable')
  if (soldOnAppStore(licence) && licence.appStore?.code) return pro('checking')
  if (seatMissing(licence)) return pro('seat')
  if (soldOnAppStore(licence)) return { kind: 'purchase' }
  if (licence.state === 'revoked' || licence.state === 'invalid') return pro('attention')
  return pro('key')
}

interface Asked {
  readonly intent: WriteIntent
  readonly run: () => void
}

let pending: (Asked & { at: number }) | null = null
let unlocked: Asked | null = null
let proSheet: ProSheetState | null = null
let surface: LockSurface['kind'] | null = null
const listeners = new Set<() => void>()

const notify = () => {
  for (const listener of listeners) listener()
}

const setProSheet = (next: ProSheetState | null) => {
  proSheet = next
  notify()
}

let watching = false
function watch() {
  if (watching) return
  watching = true
  subscribeLicence(() => {
    if (pending && surface && editingAllowed()) gateUnlocked()
  })
  subscribePurchase(() => {
    if (surface === 'purchase' && !purchaseOpen()) {
      surface = null
      pending = null
    }
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') dropIntent()
  })
}

function showSurface(intent: WriteIntent, run: (() => void) | null) {
  watch()
  pending = run ? { intent, run, at: Date.now() } : null
  haptic('warning')
  const shown = lockSurface(licenceSnapshot())
  surface = shown.kind
  if (shown.kind === 'purchase') openPurchase({ gate: true })
  else setProSheet({ sheet: shown.sheet, ai: intent.op === 'ai' })
}

const surfaceUp = () => proSheet !== null || purchaseOpen()

/**
 * Runs `run` now while editing is allowed; otherwise opens the lock's one surface and keeps the
 * intent, to run through this gate again if that surface unlocks editing.
 */
export function requireEditing(intent: WriteIntent, run: () => void): void {
  if (editingAllowed()) {
    run()
    return
  }
  if (surfaceUp()) return
  showSurface(intent, run)
}

export const useRequireEditing = (): typeof requireEditing => requireEditing

/** Forgets what was asked for: the user went elsewhere, so nothing is written behind their back. */
export function dropIntent(): void {
  pending = null
  unlocked = null
}

/** Not Now, a drag down or a way out to Settings: the surface goes and the intent with it. */
export function closeGate(): void {
  pending = null
  if (surface === 'purchase' && purchaseGate()) closePurchase()
  surface = null
  setProSheet(null)
}

/**
 * A surface's own action unlocked editing (Try Free, a purchase, Restore, Try Again). The write
 * asked for runs from `useContinueUnlocked`, once React has drawn the unlock.
 */
export function gateUnlocked(): void {
  const asked = pending
  pending = null
  closeGate()
  if (asked && Date.now() - asked.at < INTENT_MS) {
    unlocked = asked
    notify()
  }
}

/**
 * Runs the write an unlock was for through the gate again, once the screens have drawn the
 * snapshot: the editor and the title drop their lock only in the effects of that render. The
 * component that calls this must render after the screens, so its effect runs after theirs.
 */
export function useContinueUnlocked(): void {
  const editing = useEditing()
  const next = useSyncExternalStore(subscribeGate, () => unlocked)
  useEffect(() => {
    if (!next || editing !== editingAllowed()) return
    unlocked = null
    requireEditing(next.intent, next.run)
  }, [editing, next])
}

/**
 * Whether `error` is Rust refusing a write the snapshot allowed (it went stale): the code goes to
 * the log, the snapshot is read again and the lock's surface shows.
 */
export function refusedWrite(op: WriteOp, error: unknown): boolean {
  const code = errorCode(error)
  if (code !== LICENCE_REQUIRED && code !== LICENCE_UNREADABLE) return false
  console.warn(`W_PHONE_WRITE_LOCKED op=${op} code=${code}`)
  void readCurrentLicence()
    .catch(() => console.warn('W_LICENCE_READ_FAILED'))
    .then(() => {
      if (!surfaceUp()) showSurface({ op, id: null }, null)
    })
  return true
}

/** Logs a write that failed, and shows the lock's surface when Rust refused it. */
export function watchWrite(
  op: WriteOp,
  write: Promise<unknown>,
  failure = 'W_PHONE_WRITE_FAILED',
): void {
  write.catch((error: unknown) => {
    if (!refusedWrite(op, error)) console.warn(failure, errorCode(error))
  })
}

function subscribeGate(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useProSheet(): ProSheetState | null {
  return useSyncExternalStore(subscribeGate, () => proSheet)
}
