import { describe, expect, it, vi } from 'vitest'
import { droppedImport } from './dropImport'
import { MAX_FILE_BYTES } from '../../core/files'
import { resolveImagePath } from '../../core/import'

const file = (name: string, text = '# Dropped') => new File([text], name)

describe('dropped imports', () => {
  it('preserves decomposed file paths so written image and note links find the browser files', async () => {
    const picture = 'photo\u0301.png'
    const note = 'cafe\u0301.md'
    const put = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const png = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], picture)
    const job = droppedImport([file(note), png], put)
    expect(job.scan.files[0]?.path).toBe(note)
    expect(job.scan.images[0]?.path).toBe(picture)
    expect(await job.source.read(note)).toBe('# Dropped')
    await job.source.attach(resolveImagePath(note, picture)!, { id: 'file-id', noteId: 'note-id' })
    expect(put).toHaveBeenCalledOnce()
  })
  it('rejects malformed UTF-8 like the native note reader and strips a BOM', async () => {
    const job = droppedImport(
      [new File([new Uint8Array([255])], 'bad.md'), file('bom.md', '\ufeff# Note')],
      vi.fn(),
    )
    await expect(job.source.read('bad.md')).rejects.toThrow('E_IMPORT_NOT_UTF8')
    expect(await job.source.read('bom.md')).toBe('# Note')
  })
  it('scans supported loose files and images with distinct negative ids', () => {
    const job = droppedImport([file('b.HTML'), file('a.markdown'), file('pic.png')], vi.fn())
    expect(job.scan.kind).toBe('files')
    expect(job.scan.files.map((f) => f.path)).toEqual(['b.HTML', 'a.markdown'])
    expect(job.scan.images.map((f) => f.path)).toEqual(['pic.png'])
    expect(job.scan.id).toBeLessThan(0)
    expect(droppedImport([], vi.fn()).scan.id).not.toBe(job.scan.id)
  })

  it('handles empty, unsupported, hidden, oversized and ambiguous names', () => {
    expect(droppedImport([], vi.fn()).scan.files).toEqual([])
    const large = file('large.md')
    Object.defineProperty(large, 'size', { value: MAX_FILE_BYTES + 1 })
    const job = droppedImport(
      [file('a.txt'), file('.hidden.md'), large, file('same.md'), file('same.md')],
      vi.fn(),
    )
    expect(job.scan.skipped.map((p) => p.code)).toEqual([
      'E_IMPORT_FILE_TYPE',
      'E_IMPORT_PATH_INVALID',
      'E_IMPORT_FILE_TOO_LARGE',
      'E_IMPORT_PATH_INVALID',
    ])
  })

  it('reads text and stores validated image bytes using the core supplied ids', async () => {
    const put = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const png = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'pic.png')
    const job = droppedImport([file('a.md'), png], put)
    expect(await job.source.read('a.md')).toBe('# Dropped')
    await job.source.attach('pic.png', { id: 'file-id', noteId: 'note-id' })
    expect(put).toHaveBeenCalledWith(
      { id: 'file-id', noteId: 'note-id', name: 'pic.png' },
      new Uint8Array(await png.arrayBuffer()),
    )
    await expect(job.source.read('missing.md')).rejects.toThrow('E_IMPORT_FILE_NOT_FOUND')
    await expect(
      droppedImport([file('bad.png')], put).source.attach('bad.png', { id: 'x', noteId: 'y' }),
    ).rejects.toThrow('E_FILE_TYPE_REFUSED')
    put.mockRejectedValue(new Error('E_STORE_FAILED'))
    await expect(job.source.attach('pic.png', { id: 'x', noteId: 'y' })).rejects.toThrow(
      'E_STORE_FAILED',
    )
    await job.cleanup()
    await expect(job.source.read('a.md')).rejects.toThrow('E_IMPORT_FILE_NOT_FOUND')
  })

  it('propagates read errors and bounds the scan', async () => {
    const unreadable = file('unreadable.md')
    unreadable.arrayBuffer = () => Promise.reject(new Error('E_IMPORT_UNREADABLE'))
    await expect(droppedImport([unreadable], vi.fn()).source.read('unreadable.md')).rejects.toThrow(
      'E_IMPORT_UNREADABLE',
    )
    expect(() =>
      droppedImport(
        Array.from({ length: 10_001 }, (_, i) => file(`${i}.md`)),
        vi.fn(),
      ),
    ).toThrow('E_IMPORT_TOO_MANY_FILES')
  })
})
