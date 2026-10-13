import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  attachmentMarkdown,
  checkUpload,
  createClock,
  createIdGenerator,
  createNoteService,
  detectImage,
  fileLinks,
  fileLinkSpans,
  MAX_FILE_BYTES,
  newFileCopies,
  replaceFileLinks,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const bytes = (text: string) => new TextEncoder().encode(text)
const FILE_ID = '0192a6f0-0000-7000-8000-00000000f001'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

function setup() {
  const storage = openSqliteAdapter(join(tempDir('devot-files-'), 'devot.sqlite'))
  open.push(storage)
  const notes = createNoteService({
    storage,
    clock: createClock('mac1'),
    newId: createIdGenerator(),
  })
  return { storage, notes }
}

describe('image detection', () => {
  it('recognises supported raster formats from their bytes', () => {
    expect(detectImage(PNG)).toBe('image/png')
    expect(detectImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(detectImage(bytes('GIF89a....'))).toBe('image/gif')
    expect(detectImage(bytes('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(detectImage(bytes('\0\0\0\x1cftypavif'))).toBe('image/avif')
    expect(detectImage(bytes('\0\0\0\x18ftypheic'))).toBe('image/heic')
  })

  it('refuses SVG, HTML and unknown bytes', () => {
    expect(detectImage(bytes('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull()
    expect(detectImage(bytes('<!doctype html><script>'))).toBeNull()
    expect(detectImage(new Uint8Array())).toBeNull()
  })
})

describe('uploads', () => {
  const meta = { id: FILE_ID, noteId: 'n', name: 'photo.png' }

  it('checks name, size and format', () => {
    expect(checkUpload(meta, PNG)).toBe('image/png')
    expect(() => checkUpload({ ...meta, name: '' }, PNG)).toThrow('E_FILE_NAME_INVALID')
    expect(() => checkUpload({ ...meta, name: 'a\nb' }, PNG)).toThrow('E_FILE_NAME_INVALID')
    expect(() => checkUpload(meta, new Uint8Array())).toThrow('E_FILE_SIZE_INVALID')
    const huge = new Uint8Array(MAX_FILE_BYTES + 1)
    huge.set(PNG)
    expect(() => checkUpload(meta, huge)).toThrow('E_FILE_SIZE_INVALID')
    expect(() => checkUpload(meta, bytes('<svg/>'))).toThrow('E_FILE_TYPE_REFUSED')
  })

  it('writes Markdown with the file name as alt text', () => {
    expect(attachmentMarkdown({ ...meta, name: 'Screen Shot [1].png' })).toBe(
      `![Screen Shot 1](devot://file/${FILE_ID})`,
    )
  })
})

describe('attachment links', () => {
  const OTHER = '0192a6f0-0000-7000-8000-00000000f002'
  const COPY = '0192a6f0-0000-7000-8000-00000000f003'

  it('finds each attachment a body shows once, by its UUIDv7', () => {
    const body = `![a](devot://file/${FILE_ID}) ![](devot://file/${OTHER}) devot://file/${FILE_ID}`
    expect(fileLinks(body)).toEqual([FILE_ID, OTHER])
    expect(fileLinks(`devot://file/${FILE_ID}0 devot://file/x devot://note/${OTHER}`)).toEqual([])
  })

  it('replaces only the copied IDs', () => {
    const body = `![a](devot://file/${FILE_ID}) ![b](devot://file/${OTHER}) ${FILE_ID}`
    expect(replaceFileLinks(body, [{ from: FILE_ID, to: COPY }])).toBe(
      `![a](devot://file/${COPY}) ![b](devot://file/${OTHER}) ${FILE_ID}`,
    )
  })

  it('reads and keeps a size preset after the ID', () => {
    const body = `![a](devot://file/${FILE_ID}#half) ![b](devot://file/${OTHER}#small)`
    expect(fileLinks(body)).toEqual([FILE_ID, OTHER])
    expect(replaceFileLinks(body, [{ from: FILE_ID, to: COPY }])).toBe(
      `![a](devot://file/${COPY}#half) ![b](devot://file/${OTHER}#small)`,
    )
  })

  it("finds where each link's ID is, every time it appears", () => {
    const body = `x ![a](devot://file/${FILE_ID}#full)\n![](devot://file/${FILE_ID}) devot://file/${OTHER}`
    const spans = fileLinkSpans(body)
    expect(spans.map((s) => s.id)).toEqual([FILE_ID, FILE_ID, OTHER])
    for (const { id, index } of spans) expect(body.slice(index, index + id.length)).toBe(id)
    expect(fileLinkSpans(`devot://file/${FILE_ID}0 devot://note/${OTHER}`)).toEqual([])
  })

  it('plans one copy under a new ID for each attachment a body shows', () => {
    const ids = [COPY, '0192a6f0-0000-7000-8000-00000000f004']
    const body = `![](devot://file/${FILE_ID}) ![](devot://file/${OTHER}#half) ![](devot://file/${FILE_ID})`
    const copies = newFileCopies(body, () => ids.shift() as string)
    expect(copies).toEqual([
      { from: FILE_ID, to: COPY },
      { from: OTHER, to: '0192a6f0-0000-7000-8000-00000000f004' },
    ])
    expect(replaceFileLinks(body, copies)).toBe(
      `![](devot://file/${COPY}) ![](devot://file/0192a6f0-0000-7000-8000-00000000f004#half) ![](devot://file/${COPY})`,
    )
    expect(newFileCopies('No images', () => COPY)).toEqual([])
  })
})

describe('attachments on SQLite', () => {
  it('stores files for live notes, keeps them in the trash and deletes them on purge', async () => {
    const { storage, notes } = setup()
    const id = await notes.create('With picture')
    await storage.putFile({ id: FILE_ID, noteId: id, name: 'a.png' }, PNG)
    const count = () =>
      (storage.db.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n
    expect(count()).toBe(1)
    await expect(
      storage.putFile({ id: 'x', noteId: 'missing', name: 'a.png' }, PNG),
    ).rejects.toThrow('E_NOTE_NOT_FOUND')

    await notes.trash(id)
    expect(count()).toBe(1)
    await expect(storage.putFile({ id: 'y', noteId: id, name: 'b.png' }, PNG)).rejects.toThrow(
      'E_NOTE_NOT_FOUND',
    )
    await notes.purge(id)
    expect(count()).toBe(0)
  })
})
