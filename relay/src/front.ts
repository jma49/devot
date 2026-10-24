import {
  decodeFrame,
  isVaultId,
  LIMITS,
  PROTOCOL_VERSION,
  ProtocolError,
  SUBPROTOCOL,
  TOKEN_SUBPROTOCOL_PREFIX,
} from '../../src/core/sync/protocol.ts'
import { isRelaySecret, tokenDevice, validSecret } from './tokens.ts'
import type { Reply } from './vault.ts'

// The relay's front door, the same on every host: routes, the relay secret for
// vault creation, and the device token's MAC for sockets. Nothing that fails
// here reaches a vault's storage.

export interface Vaults {
  create(vault: string, body: Record<string, unknown>): Promise<Reply>
  enroll(vault: string, body: Record<string, unknown>): Promise<Reply>
}

export interface SocketTarget {
  vault: string
  device: string
  token: string
}

const VAULT_PATH = /^\/v1\/vaults\/([^/]+)(\/devices|\/socket)?$/

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
  const match = VAULT_PATH.exec(pathname)
  const vault = match?.[1]
  if (!match || !isVaultId(vault) || match[2] === '/socket' || request.method !== 'POST') {
    return notFound()
  }
  const creating = match[2] === undefined
  if (creating) {
    const presented = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1]
    if (!presented || !(await isRelaySecret(secret, presented))) {
      return errorResponse(401, 'E_SYNC_UNAUTHORIZED')
    }
  }
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > LIMITS.maxHttpBodyBytes) return errorResponse(413, 'E_SYNC_TOO_LARGE')
  const body = await readLimited(request, LIMITS.maxHttpBodyBytes)
  if (!body) return errorResponse(413, 'E_SYNC_TOO_LARGE')
  let message: Record<string, unknown>
  try {
    message = decodeFrame(new TextDecoder().decode(body)).message
  } catch (error) {
    return errorResponse(400, error instanceof ProtocolError ? error.code : 'E_SYNC_BAD_MESSAGE')
  }
  if (message['type'] !== (creating ? 'create' : 'enroll')) {
    return errorResponse(400, 'E_SYNC_BAD_MESSAGE')
  }
  const reply = creating ? await vaults.create(vault, message) : await vaults.enroll(vault, message)
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
