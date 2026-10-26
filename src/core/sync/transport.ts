// The engine's view of the relay. In the app Rust holds the socket, the device token and the vault
// key, and seals and opens records (no key ever reaches the web view); the core hands it plaintext
// and gets plaintext back. Tests run a transport of their own against the Node relay.

import type { QuotaLimit, RecordKind } from './protocol'

export interface Welcome {
  /** The relay's clock, in milliseconds. */
  time: number
  epoch: string
  seq: number
  device: string
  /** Whether the relay enforces the quota cap; absent (or null) from a relay older than the cap. */
  quota?: 'on' | 'off' | null
}

export interface PulledRecord {
  id: string
  version: number
  seq: number
  kind: RecordKind
  /** Opened; absent with `error` (a record that does not open, or a kind this build leaves alone). */
  plaintext?: Uint8Array
  error?: string
}

export interface PullPage {
  records: PulledRecord[]
  next: number
  more: boolean
}

export type PushResult =
  | { type: 'pushed'; version: number; seq: number }
  | { type: 'rejected'; version: number }
  /** The relay's quota cap (E_SYNC_QUOTA): pushes wait until `until`, the relay's next 00:00 UTC; null when it did not say. */
  | { type: 'paused'; until: number | null; limit?: QuotaLimit | null }

export type SyncEvent =
  | { type: 'changed'; seq: number }
  /** The socket closed: `code` says why (E_SYNC_REVOKED, E_SYNC_UNAUTHORIZED, E_SYNC_NO_VAULT, E_SYNC_OFFLINE). */
  | { type: 'closed'; code: string }

/** Every call rejects with an Error whose message is a code: E_SYNC_OFFLINE, E_SYNC_TOO_LARGE, E_SYNC_REVOKED and the relay's own. */
export interface SyncTransport {
  connect(): Promise<Welcome>
  pull(since: number): Promise<PullPage>
  /** Seals `plaintext` as version `base + 1` of record `id` and offers it to the relay. */
  push(id: string, base: number, plaintext: Uint8Array): Promise<PushResult>
  close(): Promise<void>
}
