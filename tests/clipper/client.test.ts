import { createServer } from 'node:http'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { ApiClient, MAX_IMAGE_BYTES } from '../../clipper/client'

const requests: {
  path: string
  auth: string | undefined
  origin: string | undefined
  type: string | undefined
  body: string
}[] = []
let empty = false
let failUpload = false
let failPatch = false
let editOnUpload = false
let failRead = false
let noteMarkdown = ''
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
  if (req.url?.startsWith('/image')) {
    if (req.url === '/image-missing') res.writeHead(404).end()
    else if (req.url === '/image-large')
      res.writeHead(200, { 'Content-Length': MAX_IMAGE_BYTES + 1 }).end()
    else if (req.url === '/image-invalid') res.end('<svg/>')
    else res.end(Buffer.from('iVBORw0KGgo=', 'base64'))
  } else if (req.headers.authorization !== 'Bearer secret') {
    res.writeHead(401).end(JSON.stringify({ error: 'E_HTTP_TOKEN_INVALID' }))
  } else if (req.method === 'GET' && req.url === '/v1/notes/note') {
    if (failRead) res.writeHead(404).end(JSON.stringify({ error: 'E_NOTE_NOT_FOUND' }))
    else res.end(JSON.stringify({ markdown: noteMarkdown }))
  } else if (req.method === 'GET') {
    res.end(
      JSON.stringify({
        notebooks: empty ? [] : [{ id: 'book', name: 'Inbox', notes: 0 }],
      }),
    )
  } else if (req.url?.endsWith('/files')) {
    if (editOnUpload) noteMarkdown = 'User edits made while an image was uploading'
    if (failUpload) res.writeHead(400).end(JSON.stringify({ error: 'E_FILE_TYPE_REFUSED' }))
    else res.writeHead(201).end(JSON.stringify({ id: 'file', url: 'devot://file/file' }))
  } else if (req.method === 'PATCH' && failPatch) {
    res.writeHead(400).end(JSON.stringify({ error: 'E_NOTE_BODY_TOO_LARGE' }))
  } else {
    if (req.method === 'POST' && req.url === '/v1/notes') noteMarkdown = JSON.parse(body).markdown
    res.writeHead(201).end(JSON.stringify({ id: 'note' }))
  }
})

it('creates the note, downloads and uploads images, then patches local image links', async () => {
  const start = requests.length
  const image = `http://127.0.0.1:${port}/image`
  const steps: number[] = []
  await expect(
    new ApiClient({ port, token: 'secret' }).save(
      {
        title: 'Article',
        notebook: 'book',
        markdown: `![Photo](${image})\n\nSource`,
      },
      true,
      (done) => steps.push(done),
    ),
  ).resolves.toEqual({ id: 'note', imagesKept: false })
  expect(steps).toEqual([0, 1])
  const calls = requests.slice(start)
  expect(calls[1]?.auth).toBeUndefined()
  expect(calls.map((c) => c.path)).toEqual([
    '/v1/notes',
    '/image',
    '/v1/notes/note/files',
    '/v1/notes/note',
    '/v1/notes/note',
  ])
  expect(JSON.parse(calls[2]!.body)).toEqual({
    name: 'image.png',
    type: 'image/png',
    data: 'iVBORw0KGgo=',
  })
  expect(calls[3]?.body).toBe('')
  expect(JSON.parse(calls[4]!.body)).toEqual({
    markdown: '![Photo](devot://file/file)\n\nSource',
  })
})

it('leaves the note untouched when its body changes while images upload', async () => {
  const start = requests.length
  editOnUpload = true
  try {
    await expect(
      new ApiClient({ port, token: 'secret' }).save(
        {
          title: 'Article',
          notebook: 'book',
          markdown: `![Photo](http://127.0.0.1:${port}/image)`,
        },
        true,
      ),
    ).resolves.toEqual({ id: 'note', imagesKept: true })
    expect(noteMarkdown).toBe('User edits made while an image was uploading')
    expect(requests.slice(start).map((call) => [call.path, call.body])).toEqual([
      ['/v1/notes', expect.any(String)],
      ['/image', ''],
      ['/v1/notes/note/files', expect.any(String)],
      ['/v1/notes/note', ''],
    ])
  } finally {
    editOnUpload = false
  }
})

it('reports the note saved, with remote images, when its body cannot be read back', async () => {
  const start = requests.length
  failRead = true
  try {
    await expect(
      new ApiClient({ port, token: 'secret' }).save(
        {
          title: 'Article',
          notebook: 'book',
          markdown: `![Photo](http://127.0.0.1:${port}/image)`,
        },
        true,
      ),
    ).resolves.toEqual({ id: 'note', imagesKept: true })
    expect(requests.at(-1)).toMatchObject({ path: '/v1/notes/note', body: '' })
    expect(requests.slice(start)).toHaveLength(4)
  } finally {
    failRead = false
  }
})

it('keeps remote URLs for missing, oversize and unsupported images', async () => {
  const start = requests.length
  const markdown = ['missing', 'large', 'invalid']
    .map((reason) => `![Photo](http://127.0.0.1:${port}/image-${reason})`)
    .join('\n\n')
  await new ApiClient({ port, token: 'secret' }).save(
    { title: 'Article', notebook: 'book', markdown },
    true,
  )
  expect(
    requests
      .slice(start)
      .filter((c) => c.path.startsWith('/v1/'))
      .map((c) => c.path),
  ).toEqual(['/v1/notes'])
})

it('keeps a remote URL on upload refusal and a failed final patch, never failing a saved note', async () => {
  const note = {
    title: 'Article',
    notebook: 'book',
    markdown: `![Photo](http://127.0.0.1:${port}/image)`,
  }
  const client = new ApiClient({ port, token: 'secret' })
  failUpload = true
  try {
    const start = requests.length
    await expect(client.save(note, true)).resolves.toEqual({
      id: 'note',
      imagesKept: true,
    })
    expect(requests.slice(start).map((c) => c.path)).toEqual([
      '/v1/notes',
      '/image',
      '/v1/notes/note/files',
    ])
  } finally {
    failUpload = false
  }
  failPatch = true
  try {
    await expect(client.save(note, true)).resolves.toEqual({
      id: 'note',
      imagesKept: true,
    })
  } finally {
    failPatch = false
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
  expect(await client.save(note)).toEqual({ id: 'note', imagesKept: false })
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
  ).resolves.toEqual({ id: 'note', imagesKept: false })
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
