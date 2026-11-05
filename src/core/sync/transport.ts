// The engine's view of where the vault's records live: a relay today, and the owner's iCloud
// (docs/adr/0015-sync-through-icloud-with-devots-own-encryption.md). In the app Rust holds the
// socket, the device token and the vault key, and seals and opens records (no key ever reaches the
// web view); the core hands it plaintext and gets plaintext back. Tests run a transport of their
// own against the Node relay, and a fake one with cursors and tags that are not numbers.

import { errorCode } from '../errors'
import type { QuotaLimit, RecordKind } from './protocol'

/** The status code of a pause by the relay's stored-bytes cap, which the 00:00 UTC reset does not lift: only deleting or purging does. */
export const STORAGE_FULL = 'E_SYNC_STORAGE_FULL'
/** The relay's quota cap: pushes wait for its next 00:00 UTC. */
export const QUOTA = 'E_SYNC_QUOTA'
/** The owner's iCloud storage is full: a pause with no end, looked at again on launch, on focus and hourly. */
export const ICLOUD_FULL = 'E_SYNC_ICLOUD_FULL'
/** The vault moved to another transport (the moved marker, `moved.ts`): sync stops until the owner follows. */
export const VAULT_MOVED = 'E_SYNC_VAULT_MOVED'
/** No iCloud account is signed in, or it may not use iCloud: a pause with no end, looked at again as a full iCloud is, and on an account change. */
export const ICLOUD_SIGNED_OUT = 'E_SYNC_ICLOUD_SIGNED_OUT'
export const ICLOUD_RESTRICTED = 'E_SYNC_ICLOUD_RESTRICTED'
/** A stored cursor the transport no longer reads: the pull starts again from `START`, once. */
export const CURSOR_INVALID = 'E_SYNC_CURSOR_INVALID'
/** A stored change tag the transport cannot read (one kept from before a switch): the record is pushed again without it, once. */
export const TAG_INVALID = 'E_SYNC_TAG_INVALID'

/** Where the vault's records live; the moved marker names one. */
export type TransportName = 'relay' | 'icloud'

/**
 * A place in the vault's change feed, opaque to the engine: on a relay the decimal `seq`, on
 * iCloud an archived change token. `START` is before every record.
 */
export type Cursor = string
export const START: Cursor = ''

/** A stored cursor as the engine reads it: releases before opaque cursors stored `'0'` for the start. */
export const storedCursor = (value: string | undefined): Cursor =>
  value === undefined || value === '0' ? START : value

export interface Welcome {
  /** The transport's clock, in milliseconds. */
  time: number
  epoch: string
  /** Where the change feed is now. */
  cursor: Cursor
  device: string
  /** Whether the relay enforces the quota cap; absent (or null) from a relay older than the cap. */
  quota?: 'on' | 'off' | null
  /** Whether the relay enforces the attachment share; absent (or null) from a relay older than it. */
  attachments?: 'on' | 'off' | null
}

export interface PulledRecord {
  id: string
  /** The name the store files the record under, when that is not its ID; `id` is this name when the record does not open. */
  name?: string
  version: number
  /** The relay's sequence number; other transports have none. */
  seq?: number
  /** The record's change tag, opaque: kept with the entry and sent back with the next push's base. `''` on a relay. */
  tag: string
  kind: RecordKind
  /** Opened; absent with `error` (a record that does not open, or a kind this build leaves alone). */
  plaintext?: Uint8Array
  error?: string
}

export interface PullPage {
  records: PulledRecord[]
  next: Cursor
  more: boolean
}

export type PushResult =
  | { type: 'pushed'; version: number; tag: string; seq?: number }
  /** Another device wrote first: the version and change tag the transport holds, for the push after the merge. */
  | { type: 'rejected'; version: number; tag: string }
  /**
   * Pushes wait. With no `code`, or `E_SYNC_QUOTA`, it is the relay's quota cap: until `until`, the
   * relay's next 00:00 UTC (null when it did not say), and `limit` says which cap. Any other code
   * is a pause of another transport: until `until` exactly, on the transport's clock, or with no
   * end when `until` is null (E_SYNC_ICLOUD_FULL).
   */
  | { type: 'paused'; until: number | null; code?: string; limit?: QuotaLimit | null }
  /** The relay's share for attachments is used up (E_SYNC_ATTACHMENTS_FULL): notes still go in. */
  | { type: 'full' }
  /** From `pushMany` only: this item failed with `code`, the error `push` would have thrown. */
  | { type: 'failed'; code: string }

export interface PushItem {
  id: string
  /** The version this push is based on; it becomes version `base + 1`. */
  base: number
  /** The change tag that came with `base`; `''` for a record the transport does not hold yet. */
  tag: string
  plaintext: Uint8Array
  kind: RecordKind
}

export type SyncEvent =
  | { type: 'changed'; cursor: Cursor }
  /** The iCloud account changed (signed in, out, or another): the engine connects again, which checks it. */
  | { type: 'account' }
  /** The socket closed: `code` says why (E_SYNC_REVOKED, E_SYNC_UNAUTHORIZED, E_SYNC_NO_VAULT, E_SYNC_OFFLINE). */
  | { type: 'closed'; code: string }

/** Every call rejects with an Error whose message is a code: E_SYNC_OFFLINE, E_SYNC_TOO_LARGE, E_SYNC_REVOKED and the transport's own. */
export interface SyncTransport {
  connect(): Promise<Welcome>
  pull(since: Cursor): Promise<PullPage>
  /** Seals `plaintext` as version `base + 1` of record `id` (of `kind`, `record` unless it is an attachment) and offers it, based on `base` and its change `tag`. */
  push(
    id: string,
    base: number,
    plaintext: Uint8Array,
    kind?: RecordKind,
    tag?: string,
  ): Promise<PushResult>
  /** Pushes each item as `push` would, one result per item in order; it rejects only when the whole call failed. */
  pushMany(items: readonly PushItem[]): Promise<PushResult[]>
  close(): Promise<void>
}

/** A pause the pass goes on through, with the records that still fit: the relay's stored bytes, or a full iCloud. */
export const pauseGoesOn = (result: PushResult): boolean =>
  result.type === 'paused' && (result.limit === 'storedBytes' || result.code === ICLOUD_FULL)

/** A push failure that belongs to the record, not the connection: the pass goes on without it. */
export const recordFailure = (code: string, kind: RecordKind): boolean =>
  code === 'E_SYNC_TOO_LARGE' || (kind === 'file' && code === 'E_SYNC_BAD_MESSAGE')

/**
 * `pushMany` for a transport that takes one push at a time (the relay). After an answer that ends
 * the pass (a pause, or a failure of the connection), the rest are not sent and get that answer too.
 */
export async function pushOneByOne(
  push: SyncTransport['push'],
  items: readonly PushItem[],
): Promise<PushResult[]> {
  const results: PushResult[] = []
  for (const item of items) {
    let result: PushResult
    try {
      result = await push(item.id, item.base, item.plaintext, item.kind, item.tag)
    } catch (error) {
      result = { type: 'failed', code: errorCode(error, 'E_SYNC_FAILED') }
    }
    results.push(result)
    const ends =
      (result.type === 'paused' && !pauseGoesOn(result)) ||
      (result.type === 'failed' && !recordFailure(result.code, item.kind))
    if (ends) {
      while (results.length < items.length) results.push(result)
      break
    }
  }
  return results
}
