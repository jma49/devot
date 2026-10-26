import { request } from 'node:http'
import {
  decodeFrame,
  encodeFrame,
  type EnrolledReply,
  enrollmentVerifier,
  SUBPROTOCOL,
  toBase64Url,
  TOKEN_SUBPROTOCOL_PREFIX,
} from '../../src/core/sync/protocol'

// A test client for the relay: plain HTTP for vault creation and enrollment, the
// platform WebSocket for the rest, so both hosts are driven exactly as a client would.

export interface RelayHost {
  url: string
  /** The relay's own secret (RELAY_SECRET), which vault creation needs. */
  secret: string
  close(): Promise<void>
}

export interface Received {
  message: Record<string, unknown>
  payload: Uint8Array
}

const TIMEOUT_MS = 10_000

export class TestSocket {
  readonly closed: Promise<{ code: number; reason: string }>
  private readonly ws: WebSocket
  private readonly queue: Received[] = []
  private readonly waiters: ((received: Received) => void)[] = []

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.binaryType = 'arraybuffer'
    ws.addEventListener('message', (event) => {
      const received = decodeFrame(event.data as string | ArrayBuffer)
      const waiter = this.waiters.shift()
      if (waiter) waiter(received)
      else this.queue.push(received)
    })
    this.closed = new Promise((resolve) =>
      ws.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason })),
    )
  }

  static open(url: string, protocols: string[]): Promise<TestSocket> {
    const ws = new WebSocket(url, protocols)
    const socket = new TestSocket(ws)
    return new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve(socket))
      ws.addEventListener('error', () => reject(new Error('E_TEST_SOCKET_FAILED')))
    })
  }

  get protocol(): string {
    return this.ws.protocol
  }

  send(message: object, chunks: Uint8Array[] = []): void {
    this.ws.send(encodeFrame(message, chunks))
  }

  sendRaw(data: string | Uint8Array<ArrayBuffer>): void {
    this.ws.send(data)
  }

  next(): Promise<Received> {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('E_TEST_NO_MESSAGE')), TIMEOUT_MS)
      this.waiters.push((received) => {
        clearTimeout(timer)
        resolve(received)
      })
    })
  }

  /** The next message, which must be of `type`. */
  async expect(type: string): Promise<Received> {
    const received = await this.next()
    if (received.message['type'] !== type) {
      throw new Error(`expected ${type}, got ${JSON.stringify(received.message)}`)
    }
    return received
  }

  /** Whether a message is waiting or arrives within `ms`. */
  async hasMessage(ms: number): Promise<boolean> {
    if (this.queue.length > 0) return true
    await new Promise((resolve) => setTimeout(resolve, ms))
    return this.queue.length > 0
  }

  close(): void {
    this.ws.close()
  }
}

export function socketUrl(host: RelayHost, vault: string): string {
  return `${host.url.replace(/^http/, 'ws')}/v1/vaults/${vault}/socket`
}

export const socketProtocols = (token: string) => [SUBPROTOCOL, TOKEN_SUBPROTOCOL_PREFIX + token]

export async function connect(host: RelayHost, vault: string, token: string) {
  const socket = await TestSocket.open(socketUrl(host, vault), socketProtocols(token))
  const welcome = (await socket.expect('welcome')).message
  return { socket, welcome }
}

/** The HTTP status a WebSocket upgrade gets: 101 when the relay takes it. */
export function upgradeStatus(url: string, protocols: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url.replace(/^ws/, 'http'), {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
          'base64',
        ),
        'Sec-WebSocket-Protocol': protocols.join(', '),
      },
    })
    req.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve(res.statusCode ?? 0)
    })
    req.on('response', (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

export const randomId = (bytes = 16) => toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)))

export interface TestVault {
  vault: string
  enrollmentSecret: Uint8Array
  first: EnrolledReply
}

export async function createVault(host: RelayHost, label = 'first'): Promise<TestVault> {
  const vault = randomId()
  const enrollmentSecret = crypto.getRandomValues(new Uint8Array(32))
  const verifier = toBase64Url(await enrollmentVerifier(enrollmentSecret))
  const res = await postJson(
    `${host.url}/v1/vaults/${vault}`,
    { v: 1, type: 'create', verifier, label },
    { authorization: `Bearer ${host.secret}` },
  )
  if (res.status !== 200)
    throw new Error(`create failed: ${res.status} ${String(res.body['code'])}`)
  return { vault, enrollmentSecret, first: res.body as unknown as EnrolledReply }
}

export async function enroll(host: RelayHost, vault: TestVault, label = 'second') {
  return postJson(`${host.url}/v1/vaults/${vault.vault}/devices`, {
    v: 1,
    type: 'enroll',
    secret: toBase64Url(vault.enrollmentSecret),
    label,
  })
}

export async function enrolled(host: RelayHost, vault: TestVault, label = 'second') {
  const res = await enroll(host, vault, label)
  if (res.status !== 200) throw new Error(`enroll failed: ${res.status}`)
  return res.body as unknown as EnrolledReply
}

export const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill)

/** A pairing request: `op` is `pair` (the pairing's own path) or a sub-route; `token` a device's. */
export function pairingRequest(
  host: RelayHost,
  id: string,
  op: 'pair' | 'take' | 'confirm' | 'status' | 'close',
  body: Record<string, unknown>,
  token?: string,
) {
  const path = op === 'pair' ? '' : `/${op}`
  return postJson(
    `${host.url}/v1/pairings/${id}${path}`,
    { v: 1, type: op, ...body },
    token ? { authorization: `Bearer ${token}` } : {},
  )
}
