import { DurableObject } from 'cloudflare:workers'
import { CLOSE, encodeFrame, SUBPROTOCOL } from '../../src/core/sync/protocol.ts'
import { handleHttp, isSocketPath, socketTarget } from './front.ts'
import { type Outcome, type Reply, type Sql, type SqlValue, VaultRelay } from './vault.ts'

// The Cloudflare host: the Worker is the front, one Durable Object on SQLite
// storage per vault keeps the vault, and every socket uses the Hibernation API.

export interface Env {
  VAULTS: DurableObjectNamespace<VaultObject>
  RELAY_SECRET: string
}

interface Attachment {
  vault: string
  device: string
}

const VAULT_HEADER = 'x-devot-vault'
const DEVICE_HEADER = 'x-devot-device'
const TOKEN_HEADER = 'x-devot-token'

function durableSql(storage: DurableObjectStorage): Sql {
  const bind = (params: SqlValue[]) =>
    params.map((p) => (p instanceof Uint8Array ? p.slice().buffer : p))
  return {
    all(query, ...params) {
      return storage.sql
        .exec(query, ...bind(params))
        .toArray()
        .map((row) => {
          const out: Record<string, SqlValue> = {}
          for (const [key, value] of Object.entries(row)) {
            out[key] = value instanceof ArrayBuffer ? new Uint8Array(value) : (value as SqlValue)
          }
          return out
        })
    },
    run(query, ...params) {
      const cursor = storage.sql.exec(query, ...bind(params))
      cursor.toArray()
      return cursor.rowsWritten
    },
    transaction(fn) {
      return storage.transactionSync(fn)
    },
  }
}

export class VaultObject extends DurableObject<Env> {
  private relay: VaultRelay | undefined

  private relayFor(vault: string): VaultRelay {
    this.relay ??= new VaultRelay(durableSql(this.ctx.storage), vault, {
      secret: this.env.RELAY_SECRET,
    })
    return this.relay
  }

  async create(vault: string, body: Record<string, unknown>): Promise<Reply> {
    return this.relayFor(vault).create(body)
  }

  async enroll(vault: string, body: Record<string, unknown>): Promise<Reply> {
    return this.relayFor(vault).enroll(body)
  }

  override async fetch(request: Request): Promise<Response> {
    const vault = request.headers.get(VAULT_HEADER) ?? ''
    const device = request.headers.get(DEVICE_HEADER) ?? ''
    const token = request.headers.get(TOKEN_HEADER) ?? ''
    const relay = this.relayFor(vault)
    const access = await relay.authenticate(device, token)
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]
    if (access === 'ok') {
      this.ctx.acceptWebSocket(server, [device])
      server.serializeAttachment({ vault, device } satisfies Attachment)
      server.send(relay.connected(device))
    } else {
      // Accepted only to say why: a web view cannot read the status of a refused upgrade.
      const code = access === 'no-vault' ? 'E_SYNC_NO_VAULT' : 'E_SYNC_UNAUTHORIZED'
      server.accept()
      server.send(encodeFrame({ type: 'error', code }))
      server.close(access === 'no-vault' ? CLOSE.noVault : CLOSE.unauthorized, code)
    }
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'sec-websocket-protocol': SUBPROTOCOL },
    })
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const { vault, device } = ws.deserializeAttachment() as Attachment
    const outcome = this.relayFor(vault).receive(
      device,
      typeof data === 'string' ? data : new Uint8Array(data),
    )
    this.deliver(ws, outcome)
  }

  private deliver(from: WebSocket, outcome: Outcome): void {
    if (outcome.reply !== undefined) from.send(outcome.reply)
    if (outcome.changed !== undefined) {
      for (const ws of this.ctx.getWebSockets()) {
        if (ws !== from) trySend(ws, outcome.changed)
      }
    }
    if (outcome.close) {
      for (const ws of this.ctx.getWebSockets(outcome.close.device)) {
        trySend(ws, outcome.close.notice)
        ws.close(outcome.close.code, outcome.close.reason)
      }
    }
  }
}

function trySend(ws: WebSocket, data: string | Uint8Array): void {
  try {
    ws.send(data)
  } catch {
    // A socket closing as we send; its device pulls when it reconnects.
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const vaultFor = (vault: string) => env.VAULTS.get(env.VAULTS.idFromName(vault))
    if (!isSocketPath(new URL(request.url).pathname)) {
      return handleHttp(request, env.RELAY_SECRET, {
        create: (vault, body) => vaultFor(vault).create(vault, body),
        enroll: (vault, body) => vaultFor(vault).enroll(vault, body),
      })
    }
    const target = await socketTarget(request, env.RELAY_SECRET)
    if (target instanceof Response) return target
    const headers = new Headers(request.headers)
    headers.set(VAULT_HEADER, target.vault)
    headers.set(DEVICE_HEADER, target.device)
    headers.set(TOKEN_HEADER, target.token)
    return vaultFor(target.vault).fetch(new Request(request.url, { headers }))
  },
} satisfies ExportedHandler<Env>
