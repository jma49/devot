import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { imagesIn, type PreparedImport } from '../../core'
import type { ImportReply, ImportRequest } from './importWorker'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1])
const PAGE = `<h1>P</h1><img src="data:image/png;base64,${btoa(String.fromCharCode(...PNG))}">`

const replies: { message: ImportReply; transfer: Transferable[] }[] = []
const listeners: ((event: { data: ImportRequest }) => void)[] = []

const ask = (request: ImportRequest) => {
  for (const listener of listeners) listener({ data: request })
  return replies.at(-1)!
}

beforeAll(async () => {
  Object.assign(globalThis, {
    self: {
      addEventListener: (_type: string, listener: (event: { data: ImportRequest }) => void) =>
        listeners.push(listener),
      postMessage: (message: ImportReply, options: { transfer: Transferable[] }) =>
        replies.push({ message, transfer: options.transfer }),
    },
  })
  await import('./import.worker')
})

afterAll(() => {
  delete (globalThis as { self?: unknown }).self
})

describe('the import worker', () => {
  it('prepares a file and hands over the bytes of its embedded images', () => {
    const { message, transfer } = ask({
      id: 3,
      kind: 'file',
      raw: PAGE,
      path: 'page.html',
      withImages: true,
    })
    expect(message.id).toBe(3)
    const value = (message as { value: PreparedImport }).value
    expect(value.title).toBe('P')
    expect(value.embedded).toHaveLength(1)
    const [image] = value.embedded
    expect(image?.data).toEqual(PNG)
    expect(transfer).toEqual([image?.data.buffer])
    expect(value.text).toBe(`# P\n\n![](devot://file/${image?.id})\n`)
  })

  it('leaves embedded images out when there is nowhere to store them', () => {
    const { message, transfer } = ask({
      id: 4,
      kind: 'file',
      raw: PAGE,
      path: 'page.html',
      withImages: false,
    })
    const value = (message as { value: PreparedImport }).value
    expect(value.embedded).toEqual([])
    expect(value.dropped).toEqual(['data:image/png'])
    expect(transfer).toEqual([])
  })

  it('finds the image links in a text', () => {
    const text = '# A\n\n![x](a.png)\n'
    expect(ask({ id: 5, kind: 'links', text }).message).toEqual({ id: 5, value: imagesIn(text) })
  })

  it('answers a file it cannot prepare with a code', () => {
    const raw = null as unknown as string
    expect(ask({ id: 6, kind: 'file', raw, path: 'a.md', withImages: true }).message).toEqual({
      id: 6,
      code: 'E_IMPORT_FAILED',
    })
  })
})
