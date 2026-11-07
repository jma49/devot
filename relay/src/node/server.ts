import { readdirSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { type Duplex, Readable } from 'node:stream'
import Database from 'better-sqlite3'
import { WebSocket, WebSocketServer } from 'ws'
import {
  CLOSE,
  encodeFrame,
  isVaultId,
  type QuotaCaps,
  SUBPROTOCOL,
} from '../../../src/core/sync/protocol.ts'
import { errorResponse, handleHttp, isSocketPath, socketTarget } from '../front.ts'
import { PairingRelay } from '../pairing.ts'
import { type Outcome, VaultRelay } from '../vault.ts'
import { openVaultDb, sqliteSql } from './sqlite.ts'

// The Node host: one HTTP server is the front, and each vault is a SQLite file
// `<data>/<vault ID>.sqlite` (vault IDs are checked against a strict pattern first).
// Pairings live minutes, so they are kept in memory and a restart ends them.
// Every vault is swept at start and hourly, and a retired one at once.

export interface NodeRelayOptions {
  /** Folder for the vaults' databases. */
  data: string
  secret: string
  port?: number
  host?: string
  /** The cap on pushes (`VaultOptions.quota`); null runs without one. */
  quota?: QuotaCaps | null
  now?: () => number
}

export interface NodeRelay {
  url: string
  /** Sweeps every vault now, as the hourly timer does: wipes retired ones, drops abandoned ones. */
  sweep(): Promise<void>
  close(): Promise<void>
}

interface OpenVault {
  db: Database.Database
  relay: VaultRelay
  sockets: Map<WebSocket, string>
}

// Above the protocol's own limit, so a message between the two gets E_SYNC_TOO_LARGE; a bigger one closes the socket with 1009.
const MAX_PAYLOAD = 32 * 1024 * 1024
const SWEEP_EVERY_MS = 60 * 60 * 1000

export async function startNodeRelay(options: NodeRelayOptions): Promise<NodeRelay> {
  const vaults = new Map<string, OpenVault>()
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD,
    handleProtocols: (offered) => (offered.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
  })

  const open = (vault: string, create: boolean): OpenVault | null => {
    const known = vaults.get(vault)
    if (known) return known
    const db = openVaultDb(join(options.data, `${vault}.sqlite`), create)
    if (!db) return null
    const opened = {
      db,
      relay: new VaultRelay(sqliteSql(db), vault, {
        secret: options.secret,
        ...(options.quota === undefined ? {} : { quota: options.quota }),
        ...(options.now ? { now: options.now } : {}),
      }),
      sockets: new Map(),
    }
    vaults.set(vault, opened)
    return opened
  }

  const remove = (vault: string, opened: OpenVault) => {
    opened.db.close()
    vaults.delete(vault)
    const file = join(options.data, `${vault}.sqlite`)
    for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true })
  }

  const discardIfEmpty = (vault: string) => {
    const opened = vaults.get(vault)
    if (opened && !opened.relay.exists()) remove(vault, opened)
  }

  const now = options.now ?? Date.now
  let closing = false
  const sweepVault = async (vault: string) => {
    for (;;) {
      const opened = closing ? null : open(vault, false)
      if (!opened) return
      const outcome = opened.relay.sweep()
      if (outcome.drop) {
        for (const ws of opened.sockets.keys()) {
          ws.send(encodeFrame({ type: 'error', code: 'E_SYNC_NO_VAULT' }))
          ws.close(CLOSE.noVault, 'E_SYNC_NO_VAULT')
        }
        remove(vault, opened)
        return
      }
      if (outcome.next === null || outcome.next > now()) return
      // A wipe goes on slice by slice, letting other requests in between.
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  const sweepSafely = (vault: string) =>
    sweepVault(vault).catch(() => console.error(`E_RELAY_SWEEP vault=${vault}`))
  const sweepAll = async () => {
    for (const name of readdirSync(options.data)) {
      const vault = name.endsWith('.sqlite') ? name.slice(0, -'.sqlite'.length) : ''
      if (isVaultId(vault)) await sweepSafely(vault)
    }
  }
  const timer = setInterval(() => void sweepAll(), SWEEP_EVERY_MS)
  timer.unref()

  const notFound = { status: 404, body: { v: 1, type: 'error', code: 'E_SYNC_NO_VAULT' } }
  const pairingsDb = new Database(':memory:')
  const pairings = new PairingRelay(sqliteSql(pairingsDb))

  const server: Server = createServer((req, res) => {
    void (async () => {
      const response = await handleHttp(toRequest(req, true), options.secret, {
        async create(vault, body) {
          const reply = await open(vault, true)!.relay.create(body)
          discardIfEmpty(vault)
          return reply
        },
        async enroll(vault, body) {
          return (await open(vault, false)?.relay.enroll(body)) ?? notFound
        },
        async retire(vault, body) {
          const opened = open(vault, false)
          if (!opened) return notFound
          const { reply, changed } = opened.relay.retire(body)
          if (changed !== undefined) deliver(opened, null, { changed })
          void sweepSafely(vault)
          return reply
        },
        async live(vault) {
          return open(vault, false)?.relay.live() ?? false
        },
        async adopt(vault, predecessor) {
          open(vault, false)?.relay.adopt(predecessor)
        },
        async authenticate(vault, device, token) {
          return (await open(vault, false)?.relay.authenticate(device, token)) ?? 'no-vault'
        },
        async pairing(op, id, body, device) {
          return pairings.handle(op, id, body, device)
        },
      })
      await send(res, response)
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ v: 1, type: 'error', code: 'E_SYNC_INTERNAL' }))
    })
  })

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    // Node drops its own socket error listener on upgrade and ws adds one only in handleUpgrade, after the awaits below; a reset in between would end the process.
    socket.on('error', () => socket.destroy())
    void (async () => {
      const request = toRequest(req, false)
      if (!isSocketPath(new URL(request.url).pathname)) {
        return refuse(socket, errorResponse(404, 'E_SYNC_NOT_FOUND'))
      }
      const target = await socketTarget(request, options.secret)
      if (target instanceof Response) return refuse(socket, target)
      const vault = open(target.vault, false)
      const access = vault
        ? await vault.relay.authenticate(target.device, target.token)
        : 'no-vault'
      wss.handleUpgrade(req, socket, head, (ws) => {
        // An oversized or invalid frame emits 'error' (ws then closes with 1009 or 1002); unhandled it would end the process.
        ws.on('error', () => {})
        if (!vault || access !== 'ok') {
          // Accepted only to say why: a web view cannot read the status of a refused upgrade.
          const code = access === 'no-vault' ? 'E_SYNC_NO_VAULT' : 'E_SYNC_UNAUTHORIZED'
          ws.send(encodeFrame({ type: 'error', code }))
          ws.close(access === 'no-vault' ? CLOSE.noVault : CLOSE.unauthorized, code)
          return
        }
        vault.sockets.set(ws, target.device)
        ws.on('close', () => vault.sockets.delete(ws))
        ws.on('message', (data, isBinary) => {
          const bytes = data as Buffer
          const outcome = vault.relay.receive(
            target.device,
            isBinary
              ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
              : bytes.toString('utf8'),
          )
          deliver(vault, ws, outcome)
        })
        ws.send(vault.relay.connected(target.device))
      })
    })().catch(() => socket.destroy())
  })

  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve),
  )
  void sweepAll()
  const address = server.address() as AddressInfo
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address
  return {
    url: `http://${host}:${address.port}`,
    sweep: sweepAll,
    async close() {
      closing = true
      clearInterval(timer)
      for (const ws of wss.clients) ws.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      for (const opened of vaults.values()) opened.db.close()
      vaults.clear()
      pairingsDb.close()
    },
  }
}

function deliver(vault: OpenVault, from: WebSocket | null, outcome: Outcome): void {
  if (outcome.reply !== undefined) from?.send(outcome.reply)
  if (outcome.changed !== undefined) {
    for (const ws of vault.sockets.keys()) {
      if (ws !== from && ws.readyState === WebSocket.OPEN) ws.send(outcome.changed)
    }
  }
  const close = outcome.close
  if (close) {
    for (const [ws, device] of vault.sockets) {
      if (device !== close.device) continue
      ws.send(close.notice)
      ws.close(close.code, close.reason)
    }
  }
}

function toRequest(req: IncomingMessage, withBody: boolean): Request {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  const url = `http://${req.headers.host ?? 'relay'}${req.url ?? '/'}`
  const hasBody = withBody && req.method !== 'GET' && req.method !== 'HEAD'
  return new Request(url, {
    method: req.method ?? 'GET',
    headers,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: 'half' } : {}),
  } as RequestInit)
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(Buffer.from(await response.arrayBuffer()))
}

function refuse(socket: Duplex, response: Response): void {
  socket.write(
    `HTTP/1.1 ${response.status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  )
  socket.destroy()
}
