// A transport for the core's tests that is not the relay: its cursors are tokens that are not
// numbers, and every write gives a record a new change tag, which a push must name (as CloudKit's
// save policy does). It batches pushes itself, each item on its own, and can pause like a full iCloud.
import { LIMITS, type RecordKind } from '../../src/core/sync/protocol'
import type {
  Cursor,
  PullPage,
  PushItem,
  PushResult,
  SyncEvent,
  SyncTransport,
  Welcome,
} from '../../src/core/sync/transport'

interface Held {
  id: string
  version: number
  tag: string
  kind: RecordKind
  plaintext: Uint8Array
  /** Its place in the change feed. */
  at: number
}

/** A vault's records, shared by the devices that sync through it. */
export class FakeVault {
  epoch = 'fake-epoch-1'
  readonly records = new Map<string, Held>()
  private feed = 0
  private tags = 0
  private readonly tokens = new Map<string, number>()
  readonly devices = new Set<FakeTransport>()
  /** The most plaintext bytes a record may hold; past it a push fails with E_SYNC_TOO_LARGE. */
  maxBytes: number = LIMITS.maxChunkBytes
  /** Answers a push in place of the vault: a test can play a full iCloud. */
  refuse?: (item: PushItem) => PushResult | undefined

  /** A token for a place in the feed, never the number itself. */
  cursor(at: number): Cursor {
    if (at === 0) return ''
    const token = `tok_${at.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    this.tokens.set(token, at)
    return token
  }

  place(cursor: Cursor): number {
    if (cursor === '') return 0
    const at = this.tokens.get(cursor)
    if (at === undefined) throw new Error('E_SYNC_CURSOR_INVALID')
    return at
  }

  /** Everything is gone and a new epoch begins, as when the vault's zone was made again. */
  wipe() {
    this.records.clear()
    this.epoch = `fake-epoch-${Math.random().toString(36).slice(2, 8)}`
  }

  write(item: PushItem): PushResult {
    const refused = this.refuse?.(item)
    if (refused) return refused
    if (item.plaintext.length > this.maxBytes) return { type: 'failed', code: 'E_SYNC_TOO_LARGE' }
    const held = this.records.get(item.id)
    if ((held?.version ?? 0) !== item.base || (held?.tag ?? '') !== item.tag) {
      return { type: 'rejected', version: held?.version ?? 0, tag: held?.tag ?? '' }
    }
    this.feed += 1
    this.tags += 1
    const next: Held = {
      id: item.id,
      version: item.base + 1,
      tag: `tag-${this.tags.toString(36)}-${item.id.slice(-4)}`,
      kind: item.kind,
      plaintext: item.plaintext.slice(),
      at: this.feed,
    }
    this.records.set(item.id, next)
    return { type: 'pushed', version: next.version, tag: next.tag }
  }

  changed(by: FakeTransport) {
    const cursor = this.cursor(this.feed)
    for (const device of this.devices) {
      if (device !== by && device.open) device.onEvent({ type: 'changed', cursor })
    }
  }
}

export class FakeTransport implements SyncTransport {
  onEvent: (event: SyncEvent) => void = () => {}
  open = false
  pushes = 0
  pulls = 0
  /** Each `pushMany` call's items, by ID. */
  readonly batches: string[][] = []
  /** Each push's ID, base and tag, in order, batched ones included. */
  readonly sent: { id: string; base: number; tag: string }[] = []
  readonly cursors: Cursor[] = []
  /** Called with every push before it is written: a test can let another device write first. */
  beforePush?: (id: string) => Promise<void>
  /** Changes a pulled page: a test can replay an older version. */
  tamper?: (page: PullPage) => PullPage

  constructor(readonly vault: FakeVault) {
    vault.devices.add(this)
  }

  async connect(): Promise<Welcome> {
    this.open = true
    return {
      time: Date.now(),
      epoch: this.vault.epoch,
      cursor: this.vault.cursor(0),
      device: 'fake',
      quota: 'off',
      attachments: 'off',
    }
  }

  private live() {
    if (!this.open) throw new Error('E_SYNC_OFFLINE')
  }

  async pull(since: Cursor): Promise<PullPage> {
    this.live()
    this.pulls += 1
    this.cursors.push(since)
    const from = this.vault.place(since)
    const after = [...this.vault.records.values()]
      .filter((r) => r.at > from)
      .sort((a, b) => a.at - b.at)
    const records = after.slice(0, 2)
    const last = records.at(-1)?.at ?? from
    const page: PullPage = {
      records: records.map((r) => ({
        id: r.id,
        version: r.version,
        tag: r.tag,
        kind: r.kind,
        plaintext: r.plaintext.slice(),
      })),
      next: this.vault.cursor(last),
      more: after.length > records.length,
    }
    return this.tamper ? this.tamper(page) : page
  }

  private async one(item: PushItem): Promise<PushResult> {
    await this.beforePush?.(item.id)
    this.live()
    this.pushes += 1
    this.sent.push({ id: item.id, base: item.base, tag: item.tag })
    return this.vault.write(item)
  }

  async push(
    id: string,
    base: number,
    plaintext: Uint8Array,
    kind: RecordKind = 'record',
    tag = '',
  ): Promise<PushResult> {
    const result = await this.one({ id, base, tag, plaintext, kind })
    if (result.type === 'failed') throw new Error(result.code)
    if (result.type === 'pushed') this.vault.changed(this)
    return result
  }

  async pushMany(items: readonly PushItem[]): Promise<PushResult[]> {
    this.batches.push(items.map((item) => item.id))
    const results: PushResult[] = []
    for (const item of items) results.push(await this.one(item))
    if (results.some((r) => r.type === 'pushed')) this.vault.changed(this)
    return results
  }

  async close(): Promise<void> {
    this.open = false
  }
}
