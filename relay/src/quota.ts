import type { QuotaCaps, QuotaLimit } from '../../src/core/sync/protocol.ts'

// The self-imposed cap (docs/adr/0002-sync-latest-state-per-record.md, Staying inside the Workers
// Free plan; docs/sync-relay.md, Quota): pushes stop at 80% of every Workers Free limit the relay
// can count. Read the limits again before each release.

export const FREE_PLAN: QuotaCaps = {
  /** SQLite rows written a day, deletes included. */
  rowsWritten: 100_000,
  /** Durable Object requests a day; 20 incoming WebSocket messages bill as one. */
  requests: 100_000,
  /** SQLite storage in total, in bytes (5 GB). */
  storedBytes: 5_000_000_000,
}

export const QUOTA_SHARE = 0.8
export const MESSAGES_PER_REQUEST = 20

export const FREE_CAPS: QuotaCaps = {
  rowsWritten: FREE_PLAN.rowsWritten * QUOTA_SHARE,
  requests: FREE_PLAN.requests * QUOTA_SHARE,
  storedBytes: FREE_PLAN.storedBytes * QUOTA_SHARE,
}

export interface Used {
  /** Today's counts (UTC). */
  rowsWritten: number
  messages: number
  requests: number
  /** In total. */
  storedBytes: number
}

/** The limit a push adding `growth` stored bytes would go past, or null when it may go ahead. */
export function trippedLimit(used: Used, caps: QuotaCaps, growth: number): QuotaLimit | null {
  if (used.rowsWritten >= caps.rowsWritten) return 'rowsWritten'
  if (used.requests + used.messages / MESSAGES_PER_REQUEST >= caps.requests) return 'requests'
  if (growth > 0 && used.storedBytes + growth > caps.storedBytes) return 'storedBytes'
  return null
}
