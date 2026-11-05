// Sync through iCloud as Settings and the notice show it (docs/adr/0015-sync-through-icloud-with-devots-own-encryption.md).
// Every state comes from what Rust reports: the snapshot's status code and `icloudJoin`, and
// `sync_icloud_status` for whether this build and the account can use iCloud at all.
import { useEffect, useState } from 'react'
import { untilTime } from './format'
import { currentLocale, format, t, type MessageKey } from './i18n'
import { invoke } from './ipc'
import { VAULT_MOVED } from '../../core/sync/transport'
import { adoptSnapshot, type ICloudJoin, type SyncSnapshot } from './sync'

export const ICLOUD_ACCOUNTS = [
  'available',
  'noAccount',
  'restricted',
  'temporarilyUnavailable',
] as const
export type ICloudAccount = (typeof ICLOUD_ACCOUNTS)[number]

/** Rust's ICloudView: a build without the container is never `available`. */
export interface ICloudStatus {
  available: boolean
  account: ICloudAccount | null
}

export const ICLOUD_NONE: ICloudStatus = { available: false, account: null }

export function readICloudStatus(value: unknown): ICloudStatus {
  if (typeof value !== 'object' || value === null) return ICLOUD_NONE
  const v = value as Record<string, unknown>
  if (v['available'] !== true) return ICLOUD_NONE
  return { available: true, account: ICLOUD_ACCOUNTS.find((a) => a === v['account']) ?? null }
}

/** Unavailable when Rust cannot say, so Settings stays the relay's as it was. */
export const icloudStatus = (): Promise<ICloudStatus> =>
  invoke<unknown>('sync_icloud_status').then(readICloudStatus, () => ICLOUD_NONE)

/** Asked again when the sync state changes: an account change reaches the windows that way. */
export function useICloudStatus(snapshot: SyncSnapshot): ICloudStatus {
  const [status, setStatus] = useState(ICLOUD_NONE)
  const { vault, transport, enabled } = snapshot
  const changed = [
    vault,
    transport,
    enabled,
    snapshot.status.code,
    snapshot.icloudJoin?.state,
  ].join('|')
  useEffect(() => {
    let current = true
    void icloudStatus().then((next) => {
      if (current) setStatus(next)
    })
    return () => {
      current = false
    }
  }, [changed])
  return status
}

/**
 * Syncs this device's vault through iCloud, makes one, or restores it from `recoveryKey`. A vault
 * on a relay leaves the moved marker there first; Rust refuses (E_SYNC_MOVED_REFUSED) when it cannot.
 */
export const syncThroughICloud = async (recoveryKey?: string) =>
  adoptSnapshot(
    await invoke<unknown>('sync_icloud_use', recoveryKey === undefined ? {} : { recoveryKey }),
  )

export const answerICloudJoin = async (accept: boolean) =>
  adoptSnapshot(await invoke<unknown>('sync_icloud_join', { accept }))

/** After the vault's zone went, or into the Apple ID now signed in: a new epoch, a full upload. */
export const uploadToICloudAgain = async () =>
  adoptSnapshot(await invoke<unknown>('sync_icloud_upload_again'))

/**
 * Removes the vault from this Apple ID once `recoveryKey` proves it is this one
 * (E_SYNC_RECOVERY_OTHER_VAULT otherwise). The notes here stay; the vault's keys on this device go.
 */
export const leaveICloudVault = async (recoveryKey: string) =>
  adoptSnapshot(await invoke<unknown>('sync_icloud_leave', { recoveryKey }))

/** About what the vault takes in iCloud, from the records here, in bytes. */
export async function icloudStoredBytes(): Promise<number> {
  const bytes = await invoke<unknown>('sync_icloud_storage')
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0)
    throw new Error('E_SYNC_ICLOUD_STORAGE_INVALID')
  return bytes
}

export type ICloudAttention =
  | {
      kind:
        | 'signedOut'
        | 'restricted'
        | 'unavailable'
        | 'full'
        | 'accountChanged'
        | 'deleted'
        | 'noContainer'
        | 'moved'
        | 'movedHere'
        | 'joined'
    }
  | { kind: 'busy'; until: number | null }
  | { kind: 'ask'; notes: number }
  | { kind: 'fallback'; reason: NonNullable<ICloudJoin['reason']> }

type CodeKind = Exclude<ICloudAttention['kind'], 'ask' | 'fallback' | 'joined'>

const BY_CODE: Readonly<Record<string, CodeKind>> = {
  E_SYNC_ICLOUD_SIGNED_OUT: 'signedOut',
  E_SYNC_ICLOUD_RESTRICTED: 'restricted',
  E_SYNC_ICLOUD_ACCOUNT_UNAVAILABLE: 'unavailable',
  E_SYNC_ICLOUD_FULL: 'full',
  E_SYNC_ICLOUD_BUSY: 'busy',
  E_SYNC_ICLOUD_ACCOUNT_CHANGED: 'accountChanged',
  E_SYNC_ICLOUD_DELETED: 'deleted',
  E_SYNC_CLOUDKIT_UNAVAILABLE: 'noContainer',
  [VAULT_MOVED]: 'moved',
}

/** The kind of an iCloud code the vault's own state holds: paused, stopped or offline with it. */
function heldKind({ enabled, status }: SyncSnapshot): CodeKind | undefined {
  const { state, code } = status
  return enabled && code && (state === 'paused' || state === 'stopped' || state === 'offline')
    ? BY_CODE[code]
    : undefined
}

/** True when the status line shows words for the status code (see icloudAttention), so it needs no code beside it. */
export const icloudWordsCode = (snapshot: SyncSnapshot) => heldKind(snapshot) !== undefined

/** Before a vault: why the look for the Apple ID's vault could not run. */
const LOOK_BLOCKED = new Set<CodeKind>(['signedOut', 'restricted', 'unavailable'])

const ofCode = (kind: CodeKind, pausedUntil: number | null): ICloudAttention =>
  kind === 'busy' ? { kind, until: pausedUntil } : { kind }

// Rust keeps the look until the app quits: a later stop, pause or outage words itself instead.
const runsWell = ({ status }: SyncSnapshot) =>
  status.code === null &&
  (status.state === 'idle' || status.state === 'syncing' || status.state === 'connecting')

/** What iCloud asks of the owner now, if anything. */
export function icloudAttention(snapshot: SyncSnapshot): ICloudAttention | undefined {
  const held = heldKind(snapshot)
  if (held)
    // Rust finishes a move this device started at once; this is the one it could not finish yet.
    return held === 'moved' && snapshot.moveStarted
      ? { kind: 'movedHere' }
      : ofCode(held, snapshot.status.pausedUntil)
  const join = snapshot.icloudJoin
  if (!join) return undefined
  if (join.state === 'joined' && snapshot.transport === 'icloud')
    return runsWell(snapshot) ? { kind: 'joined' } : undefined
  if (snapshot.vault) return undefined
  if (join.state === 'ask') return { kind: 'ask', notes: join.notes ?? 0 }
  if (join.state === 'fallback') return { kind: 'fallback', reason: join.reason ?? 'missing' }
  const blocked = join.state === 'unavailable' && join.code ? BY_CODE[join.code] : undefined
  return blocked && LOOK_BLOCKED.has(blocked) ? ofCode(blocked, null) : undefined
}

/** Shown in the main window's notice even while sync is off: the device is not in the vault yet. */
export const BEFORE_JOINING = new Set<ICloudAttention['kind']>(['ask', 'fallback'])

/** Marks Sync in the phone's Settings: the owner has something to do there. */
export const NEEDS_OWNER = new Set<ICloudAttention['kind']>([
  'signedOut',
  'restricted',
  'full',
  'accountChanged',
  'deleted',
  'noContainer',
  'moved',
  'movedHere',
  'ask',
  'fallback',
])

/** The phone has no notice: its Settings marks Sync instead. */
export function syncNeedsOwner(snapshot: SyncSnapshot): boolean {
  const attention = icloudAttention(snapshot)
  return attention !== undefined && NEEDS_OWNER.has(attention.kind)
}

export type ICloudAction =
  | 'moveHere'
  | 'uploadAgain'
  | 'turnOff'
  | 'follow'
  | 'finish'
  | 'join'
  | 'decline'

const SETTINGS_LINES: Readonly<Record<ICloudAttention['kind'], MessageKey>> = {
  signedOut: 'syncSettings.icloudSignedOut',
  restricted: 'syncSettings.icloudRestricted',
  unavailable: 'syncSettings.icloudTemporarilyUnavailable',
  full: 'syncSettings.icloudFull',
  busy: 'syncSettings.icloudPausedUntil',
  accountChanged: 'syncSettings.icloudAccountChanged',
  deleted: 'syncSettings.icloudDeleted',
  noContainer: 'syncSettings.icloudUnavailableBuild',
  moved: 'syncSettings.vaultMoved',
  movedHere: 'syncSettings.vaultMovedHere',
  joined: 'syncSettings.icloudJoined',
  ask: 'syncSettings.icloudJoinAsk',
  fallback: 'syncSettings.icloudKeychainMissing',
}

const NOTICES: Readonly<Record<ICloudAttention['kind'], MessageKey>> = {
  signedOut: 'sync.notice.icloudSignedOut',
  restricted: 'sync.notice.icloudRestricted',
  unavailable: 'sync.notice.icloudTemporarilyUnavailable',
  full: 'sync.notice.icloudFull',
  busy: 'sync.notice.icloudPausedUntil',
  accountChanged: 'sync.notice.icloudAccountChanged',
  deleted: 'sync.notice.icloudDeleted',
  noContainer: 'sync.notice.icloudUnavailableBuild',
  moved: 'sync.notice.vaultMoved',
  movedHere: 'sync.notice.vaultMovedHere',
  joined: 'sync.notice.icloudJoined',
  ask: 'sync.notice.icloudJoinAsk',
  fallback: 'sync.notice.icloudKeychainMissing',
}

function filled(key: MessageKey, attention: ICloudAttention, pauseOver: boolean): string {
  if (attention.kind === 'busy') {
    if (attention.until === null || pauseOver) return t('syncSettings.resumingICloud')
    return format(t(key), { time: untilTime(attention.until, Date.now(), currentLocale()) })
  }
  if (attention.kind === 'ask')
    return format(t(key), { count: new Intl.NumberFormat(currentLocale()).format(attention.notes) })
  if (attention.kind === 'fallback' && attention.reason === 'otherVault')
    return t(
      key === NOTICES.fallback ? 'sync.notice.icloudOtherItem' : 'syncSettings.icloudOtherItem',
    )
  return t(key)
}

export const icloudNotice = (attention: ICloudAttention, pauseOver: boolean): string =>
  filled(NOTICES[attention.kind], attention, pauseOver)

// The phone's catalog leaves some hints empty.
const withHint = (text: string, hint: MessageKey) => (t(hint) ? `${text} ${t(hint)}` : text)

/** The words Settings > Sync shows for `attention`, and what the owner can do there. */
export function icloudLine(
  attention: ICloudAttention,
  snapshot: SyncSnapshot,
  icloud: ICloudStatus,
  pauseOver: boolean,
): { text: string; actions: readonly ICloudAction[] } {
  const text = filled(SETTINGS_LINES[attention.kind], attention, pauseOver)
  switch (attention.kind) {
    case 'accountChanged':
      return { text, actions: ['moveHere', 'turnOff'] }
    case 'deleted':
      return { text, actions: ['uploadAgain', 'turnOff'] }
    case 'noContainer':
      return { text, actions: ['turnOff'] }
    case 'moved':
      return snapshot.transport === 'relay' && icloud.available
        ? { text: withHint(text, 'syncSettings.vaultMovedHint'), actions: ['follow'] }
        : { text: withHint(text, 'syncSettings.vaultMovedElsewhere'), actions: [] }
    case 'movedHere':
      return icloud.available
        ? { text: withHint(text, 'syncSettings.vaultMovedHereHint'), actions: ['finish'] }
        : { text: withHint(text, 'syncSettings.vaultMovedElsewhere'), actions: [] }
    case 'ask':
      return { text, actions: ['join', 'decline'] }
    default:
      return { text, actions: [] }
  }
}
