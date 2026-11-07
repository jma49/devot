import { DurableObject } from 'cloudflare:workers'
import { CLOSE, encodeFrame, SUBPROTOCOL } from '../../src/core/sync/protocol.ts'
import {
  type Access,
  ANONYMOUS_BURST,
  ANONYMOUS_PER_SECOND,
  anonymousLimit,
  handleHttp,
  isSocketPath,
  sharedAnonymousLimit,
  socketTarget,
} from './front.ts'
import { RateLimiter } from './limiter.ts'
import { gone, type PairingOp, PairingRelay } from './pairing.ts'
import {
  type Outcome,
  type Reply,
  type Sql,
  type SqlValue,
  storedVaultId,
  VaultRelay,
} from './vault.ts'

// The Cloudflare host: the Worker is the front, one Durable Object on SQLite
// storage per vault keeps the vault, and every socket uses the Hibernation API.
// Each pairing has a Durable Object of its own, which an alarm empties; a vault's
// alarm wipes it once retired and drops it once abandoned empty.

export interface Env {
  VAULTS: DurableObjectNamespace<VaultObject>
  PAIRINGS: DurableObjectNamespace<PairingObject>
  RELAY_SECRET: string
  /** Absent on a relay deployed from an older relay/wrangler.toml; the in-memory limit still holds. */
  ANONYMOUS_PER_ADDRESS?: RateLimit
  ANONYMOUS_ALL?: RateLimit
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
    const relay = this.relayFor(vault)
    const reply = await relay.create(body)
    await this.schedule(relay)
    return reply
  }

  async enroll(vault: string, body: Record<string, unknown>): Promise<Reply> {
    return this.relayFor(vault).enroll(body)
  }

  async authenticate(vault: string, device: string, token: string): Promise<Access> {
    return this.relayFor(vault).authenticate(device, token)
  }

  async retire(vault: string, body: Record<string, unknown>): Promise<Reply> {
    const relay = this.relayFor(vault)
    const { reply, changed } = relay.retire(body)
    if (changed !== undefined) {
      for (const ws of this.ctx.getWebSockets()) trySend(ws, changed)
    }
    await this.schedule(relay, true)
    return reply
  }

  async live(vault: string): Promise<boolean> {
    return this.relayFor(vault).live()
  }

  async adopt(vault: string, predecessor: string): Promise<void> {
    this.relayFor(vault).adopt(predecessor)
  }

  /** Sets the alarm for the vault's next sweep; one set already stays unless `replace`. */
  private async schedule(relay: VaultRelay, replace = false): Promise<void> {
    const next = relay.nextSweep()
    if (next === null) return
    if (replace || (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(next)
    }
  }

  override async alarm(): Promise<void> {
    const vault = this.relay?.vault ?? storedVaultId(durableSql(this.ctx.storage))
    if (vault === null) return
    const outcome = this.relayFor(vault).sweep()
    if (!outcome.drop) {
      if (outcome.next !== null) await this.ctx.storage.setAlarm(outcome.next)
      return
    }
    for (const ws of this.ctx.getWebSockets()) {
      trySend(ws, encodeFrame({ type: 'error', code: 'E_SYNC_NO_VAULT' }))
      try {
        ws.close(CLOSE.noVault, 'E_SYNC_NO_VAULT')
      } catch {
        // Closed already.
      }
    }
    this.relay = undefined
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
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
      await this.schedule(relay)
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
        try {
          ws.close(outcome.close.code, outcome.close.reason)
        } catch {
          // Closed already: a revoked device's socket that kept sending.
        }
      }
    }
  }
}

export class PairingObject extends DurableObject<Env> {
  async handle(
    op: PairingOp,
    id: string,
    body: Record<string, unknown>,
    device: string,
  ): Promise<Reply> {
    const relay = PairingRelay.existing(durableSql(this.ctx.storage), op)
    if (!relay) return gone()
    const reply = relay.handle(op, id, body, device)
    const at = relay.deleteAt()
    if (at === null) await this.ctx.storage.deleteAll()
    else if (op === 'pair') await this.ctx.storage.setAlarm(at)
    return reply
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll()
  }
}

function trySend(ws: WebSocket, data: string | Uint8Array): void {
  try {
    ws.send(data)
  } catch {
    // A socket closing as we send; its device pulls when it reconnects.
  }
}

const anonymous = new RateLimiter(ANONYMOUS_BURST, ANONYMOUS_PER_SECOND)

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const vaultFor = (vault: string) => env.VAULTS.get(env.VAULTS.idFromName(vault))
    if (!isSocketPath(new URL(request.url).pathname)) {
      const address = request.headers.get('cf-connecting-ip') ?? ''
      const limited =
        anonymousLimit(anonymous, request, address, Date.now()) ??
        (await sharedAnonymousLimit(
          { perAddress: env.ANONYMOUS_PER_ADDRESS, all: env.ANONYMOUS_ALL },
          request,
          address,
        ))
      if (limited) return limited
      return handleHttp(request, env.RELAY_SECRET, {
        create: (vault, body) => vaultFor(vault).create(vault, body),
        enroll: (vault, body) => vaultFor(vault).enroll(vault, body),
        retire: (vault, body) => vaultFor(vault).retire(vault, body),
        live: (vault) => vaultFor(vault).live(vault),
        adopt: (vault, predecessor) => vaultFor(vault).adopt(vault, predecessor),
        authenticate: (vault, device, token) => vaultFor(vault).authenticate(vault, device, token),
        pairing: (op, id, body, device) =>
          env.PAIRINGS.get(env.PAIRINGS.idFromName(id)).handle(op, id, body, device),
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
