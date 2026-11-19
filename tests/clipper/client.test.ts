import { createServer } from 'node:http'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { ApiClient } from '../../clipper/client'

const requests: {
  path: string
  auth: string | undefined
  origin: string | undefined
  type: string | undefined
  body: string
}[] = []
let empty = false
const server = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += String(chunk)
  requests.push({
    path: req.url!,
    auth: req.headers.authorization,
    origin: req.headers.origin,
    type: req.headers['content-type'],
    body,
  })
  res.setHeader('Content-Type', 'application/json')
  if (req.headers.authorization !== 'Bearer secret') {
    res.writeHead(401).end(JSON.stringify({ error: 'E_HTTP_TOKEN_INVALID' }))
  } else if (req.method === 'GET') {
    res.end(JSON.stringify({ notebooks: empty ? [] : [{ id: 'book', name: 'Inbox', notes: 0 }] }))
  } else {
    res.writeHead(201).end(JSON.stringify({ id: 'note' }))
  }
})
let port: number
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})
afterAll(
  () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
)

it('lists notebooks and posts the exact note contract with authorization', async () => {
  const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
  const client = new ApiClient({ port, token: 'secret' }, origin)
  expect(await client.notebooks()).toEqual([{ id: 'book', name: 'Inbox', notes: 0 }])
  const note = { title: 'Article', markdown: 'Body', notebook: 'book' }
  expect(await client.save(note)).toEqual({ id: 'note' })
  expect(requests.at(-1)).toEqual({
    path: '/v1/notes',
    auth: 'Bearer secret',
    origin,
    type: 'application/json',
    body: JSON.stringify(note),
  })
  expect(requests.at(-2)?.path).toBe('/v1/notebooks')
  expect(requests.at(-2)?.origin).toBe(origin)
})
it('surfaces API error codes', async () => {
  await expect(new ApiClient({ port, token: 'wrong' }).notebooks()).rejects.toThrow(
    'E_HTTP_TOKEN_INVALID',
  )
})
it('returns an empty notebook list', async () => {
  empty = true
  try {
    expect(await new ApiClient({ port, token: 'secret' }).notebooks()).toEqual([])
  } finally {
    empty = false
  }
})
it('rejects invalid settings without a request', async () => {
  const count = requests.length
  await expect(new ApiClient({ port: 0, token: 'secret' }).notebooks()).rejects.toThrow(
    'E_CLIP_SETTINGS',
  )
  await expect(new ApiClient({ port, token: '' }).notebooks()).rejects.toThrow('E_CLIP_SETTINGS')
  expect(requests).toHaveLength(count)
})
it('accepts exactly the API limit', async () => {
  await expect(
    new ApiClient({ port, token: 'secret' }).save({
      title: 'Limit',
      markdown: 'a'.repeat(1024 * 1024),
      notebook: 'book',
    }),
  ).resolves.toEqual({ id: 'note' })
})
it('enforces the UTF-8 Markdown byte limit before fetching', async () => {
  const count = requests.length
  await expect(
    new ApiClient({ port, token: 'secret' }).save({
      title: '',
      markdown: '\u00e9'.repeat(524289),
      notebook: 'book',
    }),
  ).rejects.toThrow('E_NOTE_BODY_TOO_LARGE')
  expect(requests).toHaveLength(count)
})
