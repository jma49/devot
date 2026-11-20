import { createServer } from 'node:http'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { ApiClient } from '../../clipper/client'
import { check } from '../../clipper/setup'

let refusal: string | undefined
let readOnly = false
let books = [{ id: 'book', name: 'Inbox', notes: 0 }]
const writes: string[] = []
const server = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += String(chunk)
  res.setHeader('Content-Type', 'application/json')
  if (refusal) res.writeHead(refusal === 'E_HTTP_ORIGIN_REFUSED' ? 403 : 401)
  if (refusal) return res.end(JSON.stringify({ error: refusal }))
  if (req.method === 'GET') return res.end(JSON.stringify({ notebooks: books }))
  writes.push(body)
  res.writeHead(readOnly ? 403 : 400).end(
    JSON.stringify({
      error: readOnly ? 'E_HTTP_READ_ONLY' : 'E_HTTP_BODY_INVALID',
    }),
  )
})
let port: number
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const api = () => new ApiClient({ port, token: 'secret' })

it('passes every check and probes writing with an empty body that makes no note', async () => {
  writes.length = 0
  expect(await check(api())).toEqual({
    passed: ['connection', 'origin', 'token', 'write', 'notebooks'],
    notebooks: 1,
  })
  expect(writes).toEqual(['{}'])
})

it.each([
  ['E_HTTP_ORIGIN_REFUSED', 'origin', ['connection']],
  ['E_HTTP_TOKEN_INVALID', 'token', ['connection', 'origin']],
])('stops at the guard that refused %s', async (code, step, passed) => {
  refusal = code
  try {
    expect(await check(api())).toEqual({
      passed,
      failed: { check: step, code },
      notebooks: 0,
    })
  } finally {
    refusal = undefined
  }
})

it('names a read-only token and a library with no notebook open to clips', async () => {
  readOnly = true
  try {
    expect((await check(api())).failed).toEqual({
      check: 'write',
      code: 'E_HTTP_READ_ONLY',
    })
  } finally {
    readOnly = false
  }
  books = []
  try {
    expect(await check(api())).toEqual({
      passed: ['connection', 'origin', 'token', 'write'],
      failed: { check: 'notebooks', code: 'E_CLIP_NOTEBOOKS' },
      notebooks: 0,
    })
  } finally {
    books = [{ id: 'book', name: 'Inbox', notes: 0 }]
  }
})

it('fails the first check when Devot cannot be reached or the settings are empty', async () => {
  expect((await check(new ApiClient({ port: 1, token: 'secret' }))).failed).toEqual({
    check: 'connection',
    code: 'E_CLIP_CONNECTION',
  })
  expect((await check(new ApiClient({ port, token: '' }))).failed).toEqual({
    check: 'token',
    code: 'E_CLIP_SETTINGS',
  })
})
