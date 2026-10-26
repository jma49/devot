import {
  decodeFrame,
  isPairingId,
  isVaultId,
  LIMITS,
  PROTOCOL_VERSION,
  ProtocolError,
  SUBPROTOCOL,
  TOKEN_SUBPROTOCOL_PREFIX,
} from '../../src/core/sync/protocol.ts'
import { isRelaySecret, tokenDevice, validSecret } from './tokens.ts'
import { HOST_OPS, type PairingOp } from './pairing.ts'
import type { Reply } from './vault.ts'

// The relay's front door, the same on every host: routes, the relay secret for
// vault creation, and the device token's MAC for sockets. Nothing that fails
// here reaches a vault's storage.

export type Access = 'ok' | 'no-vault' | 'unknown'

export interface Vaults {
  create(vault: string, body: Record<string, unknown>): Promise<Reply>
  enroll(vault: string, body: Record<string, unknown>): Promise<Reply>
  /** Whether `token` is still `device`'s token in `vault` (its MAC is checked already). */
  authenticate(vault: string, device: string, token: string): Promise<Access>
  /** `device` is the opening device for `pair`, `status` and `close`, else ''. */
  pairing(op: PairingOp, id: string, body: Record<string, unknown>, device: string): Promise<Reply>
}

export interface SocketTarget {
  vault: string
  device: string
  token: string
}

const VAULT_PATH = /^\/v1\/vaults\/([^/]+)(\/devices|\/socket)?$/
const PAIRING_PATH = /^\/v1\/pairings\/([^/]+)(?:\/(take|confirm|status|close))?$/

export function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

export const errorResponse = (status: number, code: string) =>
  json(status, { v: PROTOCOL_VERSION, type: 'error', code })

const notFound = () => errorResponse(404, 'E_SYNC_NOT_FOUND')

/** Answers every HTTP route but the socket, which `socketTarget` checks. */
export async function handleHttp(
  request: Request,
  secret: unknown,
  vaults: Vaults,
  now: () => number = Date.now,
): Promise<Response> {
  if (!validSecret(secret)) return errorResponse(500, 'E_RELAY_CONFIG')
  const { pathname } = new URL(request.url)
  if (pathname === '/v1') {
    if (request.method !== 'GET') return notFound()
    return json(200, {
      v: PROTOCOL_VERSION,
      type: 'relay',
      protocol: PROTOCOL_VERSION,
      time: now(),
    })
  }
  const pairing = PAIRING_PATH.exec(pathname)
  if (pairing) return handlePairing(request, secret, vaults, pairing)
  const match = VAULT_PATH.exec(pathname)
  const vault = match?.[1]
  if (!match || !isVaultId(vault) || match[2] === '/socket' || request.method !== 'POST') {
    return notFound()
  }
  const creating = match[2] === undefined
  if (creating) {
    const presented = bearer(request)
    if (!presented || !(await isRelaySecret(secret, presented))) {
      return errorResponse(401, 'E_SYNC_UNAUTHORIZED')
    }
  }
  const message = await readMessage(request)
  if (message instanceof Response) return message
  if (message['type'] !== (creating ? 'create' : 'enroll')) {
    return errorResponse(400, 'E_SYNC_BAD_MESSAGE')
  }
  const reply = creating ? await vaults.create(vault, message) : await vaults.enroll(vault, message)
  return json(reply.status, reply.body)
}

const bearer = (request: Request) =>
  /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1]

/** The body's message, or the response that refuses it. */
async function readMessage(request: Request): Promise<Record<string, unknown> | Response> {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > LIMITS.maxHttpBodyBytes) return errorResponse(413, 'E_SYNC_TOO_LARGE')
  const body = await readLimited(request, LIMITS.maxHttpBodyBytes)
  if (!body) return errorResponse(413, 'E_SYNC_TOO_LARGE')
  try {
    return decodeFrame(new TextDecoder().decode(body)).message
  } catch (error) {
    return errorResponse(400, error instanceof ProtocolError ? error.code : 'E_SYNC_BAD_MESSAGE')
  }
}

/**
 * Pairing routes (docs/adr/0008-sync-device-pairing.md). Opening, polling and closing need a device
 * token of the vault the body names, checked as a socket's is: its MAC here, its hash in the vault.
 */
async function handlePairing(
  request: Request,
  secret: string,
  vaults: Vaults,
  match: RegExpExecArray,
): Promise<Response> {
  const id = match[1]
  const op = (match[2] ?? 'pair') as PairingOp
  if (!isPairingId(id) || request.method !== 'POST') return notFound()
  const host = HOST_OPS.has(op)
  const token = host ? bearer(request) : undefined
  if (host && !token) return errorResponse(401, 'E_SYNC_UNAUTHORIZED')
  const message = await readMessage(request)
  if (message instanceof Response) return message
  if (message['type'] !== op) return errorResponse(400, 'E_SYNC_BAD_MESSAGE')
  let device = ''
  if (host) {
    const vault = message['vault']
    if (!isVaultId(vault)) return errorResponse(400, 'E_SYNC_BAD_MESSAGE')
    const named = await tokenDevice(secret, vault, token ?? '')
    if (!named) return errorResponse(401, 'E_SYNC_UNAUTHORIZED')
    const access = await vaults.authenticate(vault, named, token ?? '')
    if (access === 'no-vault') return errorResponse(404, 'E_SYNC_NO_VAULT')
    if (access !== 'ok') return errorResponse(401, 'E_SYNC_UNAUTHORIZED')
    device = named
  }
  const reply = await vaults.pairing(op, id, message, device)
  return json(reply.status, reply.body)
}

/** The request's body, or null as soon as it grows past `max` bytes. */
async function readLimited(request: Request, max: number): Promise<Uint8Array | null> {
  const parts: Uint8Array[] = []
  let size = 0
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array(0)
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > max) {
      await reader.cancel()
      return null
    }
    parts.push(value)
  }
  const body = new Uint8Array(size)
  let at = 0
  for (const part of parts) {
    body.set(part, at)
    at += part.length
  }
  return body
}

/** The vault, device and token of a socket request, or the response that refuses it. */
export async function socketTarget(
  request: Request,
  secret: unknown,
): Promise<SocketTarget | Response> {
  if (!validSecret(secret)) return errorResponse(500, 'E_RELAY_CONFIG')
  const match = VAULT_PATH.exec(new URL(request.url).pathname)
  const vault = match?.[1]
  if (!match || match[2] !== '/socket' || !isVaultId(vault) || request.method !== 'GET') {
    return notFound()
  }
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return errorResponse(426, 'E_SYNC_UPGRADE')
  }
  const offered = (request.headers.get('sec-websocket-protocol') ?? '')
    .split(',')
    .map((p) => p.trim())
  const token = offered
    .find((p) => p.startsWith(TOKEN_SUBPROTOCOL_PREFIX))
    ?.slice(TOKEN_SUBPROTOCOL_PREFIX.length)
  const device = token ? await tokenDevice(secret, vault, token) : null
  if (!token || !device) return errorResponse(401, 'E_SYNC_UNAUTHORIZED')
  if (!offered.includes(SUBPROTOCOL)) return errorResponse(400, 'E_SYNC_PROTOCOL')
  return { vault, device, token }
}

export const isSocketPath = (pathname: string) => VAULT_PATH.exec(pathname)?.[2] === '/socket'
