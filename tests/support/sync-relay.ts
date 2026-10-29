// A sync transport for the core's tests, against the Node relay started in-process: what Rust does
// in the app (src-tauri/src/sync/client.rs), with the record left unsealed and cut into chunks.
import {
  ATTACHMENTS_FULL,
  CLOSE,
  decodeFrame,
  encodeFrame,
  isQuotaLimit,
  LIMITS,
  splitChunks,
  SUBPROTOCOL,
  TOKEN_SUBPROTOCOL_PREFIX,
  type RecordHead,
  type RecordKind,
} from '../../src/core/sync/protocol'
import type {
  PulledRecord,
  PullPage,
  PushResult,
  SyncEvent,
  SyncTransport,
  Welcome,
} from '../../src/core/sync/transport'

const TIMEOUT_MS = 10_000

const CLOSE_CODES = new Map<number, string>([
  [CLOSE.unauthorized, 'E_SYNC_UNAUTHORIZED'],
  [CLOSE.revoked, 'E_SYNC_REVOKED'],
  [CLOSE.noVault, 'E_SYNC_NO_VAULT'],
])

interface Answer {
  message: Record<string, unknown>
  payload: Uint8Array
}

export interface RelayTransportOptions {
  /** Where the relay is; a function, so a test can move it (a relay started again on another port). */
  url: () => string
  vault: string
  token: () => string
  /** Smaller chunks reach the relay's chunk cap with a small record. */
  chunkBytes?: number
  /** Called with every push before it goes out: a test can hold one back. */
  beforePush?: (id: string, kind: RecordKind) => Promise<void>
  /** Cuts a push short: `before` drops the connection without sending; `after` sends and drops it before the answer, so the relay may hold the record while the device does not know. */
  cut?: (id: string, kind: RecordKind) => 'before' | 'after' | undefined
  /** Changes a pulled record: a test can play a relay that tampers. */
  tamper?: (record: PulledRecord) => PulledRecord
  /** Changes the relay's welcome: a test can play a relay from an earlier release. */
  welcome?: (welcome: Welcome) => Welcome
}

export class RelayTransport implements SyncTransport {
  onEvent: (event: SyncEvent) => void = () => {}
  pushes = 0
  pulls = 0
  /** The IDs pushed, in order. */
  readonly pushed: string[] = []
  private ws: WebSocket | undefined
  private rid = 0
  private readonly waiting = new Map<number, (answer: Answer) => void>()
  private readonly options: RelayTransportOptions

  constructor(options: RelayTransportOptions) {
    this.options = options
  }

  connect(): Promise<Welcome> {
    const url = `${this.options.url().replace(/^http/, 'ws')}/v1/vaults/${this.options.vault}/socket`
    const ws = new WebSocket(url, [SUBPROTOCOL, TOKEN_SUBPROTOCOL_PREFIX + this.options.token()])
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    return new Promise((resolve, reject) => {
      let welcomed = false
      ws.addEventListener('message', (event) => {
        const { message, payload } = decodeFrame(event.data as string | ArrayBuffer)
        if (message['type'] === 'welcome') {
          welcomed = true
          const welcome = message as unknown as Welcome
          resolve(this.options.welcome ? this.options.welcome(welcome) : welcome)
          return
        }
        const rid = message['rid']
        const waiter = typeof rid === 'number' ? this.waiting.get(rid) : undefined
        if (waiter) {
          this.waiting.delete(rid as number)
          waiter({ message, payload })
        } else if (message['type'] === 'changed') {
          this.onEvent({ type: 'changed', seq: message['seq'] as number })
        }
      })
      ws.addEventListener('close', (event) => {
        const code = CLOSE_CODES.get(event.code) ?? 'E_SYNC_OFFLINE'
        for (const waiter of this.waiting.values()) {
          waiter({ message: { type: 'error', code }, payload: new Uint8Array(0) })
        }
        this.waiting.clear()
        if (!welcomed) reject(new Error(code))
        else if (this.ws === ws) this.onEvent({ type: 'closed', code })
        if (this.ws === ws) this.ws = undefined
      })
      ws.addEventListener('error', () => {
        if (!welcomed) reject(new Error('E_SYNC_OFFLINE'))
      })
    })
  }

  private async request(message: object, chunks: Uint8Array[] = []): Promise<Answer> {
    for (;;) {
      const ws = this.ws
      if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('E_SYNC_OFFLINE')
      const rid = ++this.rid
      const answer = await new Promise<Answer>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('E_SYNC_TIMEOUT')), TIMEOUT_MS)
        this.waiting.set(rid, (a) => {
          clearTimeout(timer)
          resolve(a)
        })
        ws.send(encodeFrame({ ...message, rid }, chunks))
      })
      if (answer.message['type'] === 'error' && answer.message['code'] === 'E_SYNC_RATE') {
        await new Promise((resolve) => setTimeout(resolve, Number(answer.message['retryAfter'])))
        continue
      }
      const code = answer.message['code']
      const refusal = code === 'E_SYNC_QUOTA' || code === ATTACHMENTS_FULL
      if (refusal && 'chunks' in message) return answer
      if (answer.message['type'] === 'error') throw new Error(String(code))
      return answer
    }
  }

  async pull(since: number): Promise<PullPage> {
    this.pulls += 1
    const { message, payload } = await this.request({ type: 'pull', since })
    const heads = message['records'] as RecordHead[]
    const chunks = splitChunks(
      payload,
      heads.flatMap((h) => h.chunks),
    )
    let at = 0
    return {
      records: heads.map((head) => {
        const own = chunks.slice(at, at + head.chunks.length)
        at += head.chunks.length
        const plaintext = new Uint8Array(own.reduce((n, c) => n + c.length, 0))
        let offset = 0
        for (const chunk of own) {
          plaintext.set(chunk, offset)
          offset += chunk.length
        }
        const record = {
          id: head.id,
          version: head.version,
          seq: head.seq,
          kind: head.kind,
          plaintext,
        }
        return this.options.tamper ? this.options.tamper(record) : record
      }),
      next: message['next'] as number,
      more: message['more'] as boolean,
    }
  }

  async push(
    id: string,
    base: number,
    plaintext: Uint8Array,
    kind: RecordKind = 'record',
  ): Promise<PushResult> {
    await this.options.beforePush?.(id, kind)
    const size = this.options.chunkBytes ?? LIMITS.maxChunkBytes
    const chunks: Uint8Array[] = []
    for (let at = 0; at < plaintext.length || chunks.length === 0; at += size) {
      chunks.push(plaintext.subarray(at, at + size))
    }
    const message = { type: 'push', id, base, kind, chunks: chunks.map((c) => c.length) }
    const cut = this.options.cut?.(id, kind)
    if (cut) {
      const ws = this.ws
      if (cut === 'after') ws?.send(encodeFrame({ ...message, rid: ++this.rid }, chunks))
      await this.close()
      throw new Error('E_SYNC_OFFLINE')
    }
    this.pushes += 1
    this.pushed.push(id)
    const { message: answer } = await this.request(message, chunks)
    if (answer['type'] === 'error') {
      if (answer['code'] === ATTACHMENTS_FULL) return { type: 'full' }
      const { until, limit } = answer
      return {
        type: 'paused',
        until: typeof until === 'number' ? until : null,
        limit: isQuotaLimit(limit) ? limit : null,
      }
    }
    if (answer['type'] === 'pushed') {
      return {
        type: 'pushed',
        version: answer['version'] as number,
        seq: answer['seq'] as number,
      }
    }
    return { type: 'rejected', version: answer['version'] as number }
  }

  /** A message this transport does not send itself (`revoke`, `devices`). */
  async send(message: object): Promise<Record<string, unknown>> {
    return (await this.request(message)).message
  }

  async close(): Promise<void> {
    const ws = this.ws
    this.ws = undefined
    if (!ws || ws.readyState === WebSocket.CLOSED) return
    await new Promise<void>((resolve) => {
      ws.addEventListener('close', () => resolve())
      ws.close()
    })
  }
}
