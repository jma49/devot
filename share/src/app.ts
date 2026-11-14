import { MESSAGES } from './messages.ts'
import { VIEWER_ASSETS, VIEWER_CSP, VIEWER_SCRIPT, VIEWER_STYLE, viewerPage } from './viewer.ts'

export const MAX_ENVELOPE_BYTES = 10 * 1024 * 1024
export const LIFETIME_DAYS = [1, 7, 30] as const
const DAY_SECONDS = 86_400
const ID = /^[A-Za-z0-9_-]{22}$/
const TOKEN = /^[A-Za-z0-9_-]{43}$/

interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

/** The part of Workers KV the Worker uses, so the tests' type check needs no Workers types. */
interface Shares {
  get(key: string, type: 'stream'): Promise<ReadableStream | null>
  getWithMetadata<M>(key: string, type: 'stream'): Promise<{ metadata: M | null }>
  put(
    key: string,
    value: ArrayBuffer,
    options: { expirationTtl: number; metadata: unknown },
  ): Promise<void>
  delete(key: string): Promise<void>
}

export interface Env {
  SHARES: Shares
  CREATE_PER_ADDRESS?: RateLimit
  WRITES_ALL?: RateLimit
}

interface Meta {
  token: string
  expiresAt: number
}

class ShareError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code)
  }
}

const COMMON = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...COMMON, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

const empty = () => new Response(null, { status: 204, headers: COMMON })

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

const random = (length: number) => base64url(crypto.getRandomValues(new Uint8Array(length)))

async function digest(token: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return base64url(new Uint8Array(hash))
}

/** Constant time over equal lengths: a hash compared byte by byte would leak how much matched. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function readEnvelope(request: Request): Promise<ArrayBuffer> {
  const declared = Number(request.headers.get('Content-Length') ?? 0)
  if (declared > MAX_ENVELOPE_BYTES) throw new ShareError('E_SHARE_TOO_LARGE', 413)
  const reader = request.body?.getReader()
  if (!reader) throw new ShareError('E_SHARE_BODY_INVALID', 400)
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > MAX_ENVELOPE_BYTES) {
      await reader.cancel()
      throw new ShareError('E_SHARE_TOO_LARGE', 413)
    }
    parts.push(value)
  }
  const body = new Uint8Array(size)
  let at = 0
  for (const part of parts) {
    body.set(part, at)
    at += part.length
  }
  if (size < 4 + 12 + 16 || new TextDecoder().decode(body.subarray(0, 4)) !== 'DVS1') {
    throw new ShareError('E_SHARE_BODY_INVALID', 400)
  }
  return body.buffer
}

async function limit(env: Env, request: Request, creating: boolean): Promise<void> {
  const address = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  if (
    creating &&
    env.CREATE_PER_ADDRESS &&
    !(await env.CREATE_PER_ADDRESS.limit({ key: address })).success
  ) {
    throw new ShareError('E_SHARE_RATE_LIMITED', 429)
  }
  if (env.WRITES_ALL && !(await env.WRITES_ALL.limit({ key: 'all' })).success) {
    throw new ShareError('E_SHARE_RATE_LIMITED', 429)
  }
}

async function owned(env: Env, id: string, request: Request): Promise<Meta> {
  const auth = request.headers.get('Authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  const { metadata } = await env.SHARES.getWithMetadata<Meta>(id, 'stream')
  if (!TOKEN.test(token) || !metadata || !same(metadata.token, await digest(token))) {
    throw new ShareError('E_SHARE_NOT_FOUND', 404)
  }
  return metadata
}

async function create(env: Env, request: Request, now: number): Promise<Response> {
  const days = Number(request.headers.get('Devot-Lifetime'))
  if (!(LIFETIME_DAYS as readonly number[]).includes(days)) {
    throw new ShareError('E_SHARE_LIFETIME_INVALID', 400)
  }
  await limit(env, request, true)
  const envelope = await readEnvelope(request)
  const id = random(16)
  const token = random(32)
  const expiresAt = now + days * DAY_SECONDS * 1000
  await env.SHARES.put(id, envelope, {
    expirationTtl: days * DAY_SECONDS,
    metadata: { token: await digest(token), expiresAt } satisfies Meta,
  })
  console.log(`I_SHARE_CREATED ${id} ${days}`)
  return json({ id, token, expiresAt }, 201)
}

async function update(env: Env, id: string, request: Request, now: number): Promise<Response> {
  await limit(env, request, false)
  const meta = await owned(env, id, request)
  const envelope = await readEnvelope(request)
  const ttl = Math.floor((meta.expiresAt - now) / 1000)
  if (ttl < 60) throw new ShareError('E_SHARE_NOT_FOUND', 404)
  await env.SHARES.put(id, envelope, { expirationTtl: ttl, metadata: meta })
  console.log(`I_SHARE_UPDATED ${id}`)
  return empty()
}

async function remove(env: Env, id: string, request: Request): Promise<Response> {
  await limit(env, request, false)
  await owned(env, id, request)
  await env.SHARES.delete(id)
  console.log(`I_SHARE_DELETED ${id}`)
  return empty()
}

async function read(env: Env, id: string): Promise<Response> {
  const body = await env.SHARES.get(id, 'stream')
  if (!body) throw new ShareError('E_SHARE_NOT_FOUND', 404)
  return new Response(body, {
    headers: { ...COMMON, 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' },
  })
}

const asset = (body: string, type: string) =>
  new Response(body, {
    headers: { ...COMMON, 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' },
  })

export async function handle(request: Request, env: Env, now = Date.now()): Promise<Response> {
  const url = new URL(request.url)
  const { pathname } = url
  const method = request.method
  try {
    if (pathname === VIEWER_ASSETS.style && method === 'GET') {
      return asset(VIEWER_STYLE, 'text/css; charset=utf-8')
    }
    if (pathname === VIEWER_ASSETS.script && method === 'GET') {
      return asset(VIEWER_SCRIPT, 'text/javascript; charset=utf-8')
    }
    const viewer = /^\/s\/([^/]+)$/.exec(pathname)
    if (viewer && method === 'GET') {
      if (!ID.test(viewer[1]!)) throw new ShareError('E_SHARE_NOT_FOUND', 404)
      return new Response(viewerPage(viewer[1]!), {
        headers: {
          ...COMMON,
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': VIEWER_CSP,
          'X-Robots-Tag': 'noindex, nofollow',
          'Cache-Control': 'public, max-age=300',
        },
      })
    }
    if (pathname === '/v1/shares' && method === 'POST') return await create(env, request, now)
    const share = /^\/v1\/shares\/([^/]+)$/.exec(pathname)
    if (share) {
      const id = share[1]!
      if (!ID.test(id)) throw new ShareError('E_SHARE_NOT_FOUND', 404)
      if (method === 'GET') return await read(env, id)
      if (method === 'PUT') return await update(env, id, request, now)
      if (method === 'DELETE') return await remove(env, id, request)
      return json({ error: 'E_SHARE_METHOD' }, 405)
    }
    if (pathname === '/' && method === 'GET') {
      return Response.redirect('https://devot.online/', 302)
    }
    throw new ShareError('E_SHARE_NOT_FOUND', 404)
  } catch (error) {
    if (error instanceof ShareError) {
      if (error.status === 404 && pathname.startsWith('/s/')) {
        return new Response(MESSAGES.gone, {
          status: 404,
          headers: { ...COMMON, 'Content-Type': 'text/plain; charset=utf-8' },
        })
      }
      return json({ error: error.code }, error.status)
    }
    console.error('E_SHARE_INTERNAL')
    return json({ error: 'E_SHARE_INTERNAL' }, 500)
  }
}
