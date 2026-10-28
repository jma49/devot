// File records (docs/adr/0003-sync-attachments-as-records.md): what an attachment sends the relay,
// how it is checked on arrival as a paste is, and how two copies merge.
import { describe, expect, it } from 'vitest'
import { MAX_FILE_BYTES } from '../../src/core/files'
import {
  decodeRecord,
  encodeRecord,
  fingerprint,
  mergeFile,
  mergeRecord,
  stampsOf,
  tombstoneFile,
  type FileState,
} from '../../src/core/sync/records'

const FILE = '0192a6f0-0000-7000-8000-00000000f001'
const NOTE_A = '0192a6f0-0000-7000-8000-0000000000a1'
const NOTE_B = '0192a6f0-0000-7000-8000-0000000000b2'
const HLC_1 = '0001728000000001-0000-mac'
const HLC_2 = '0001728000000002-0000-mac'

const png = (size = 40) => {
  const bytes = new Uint8Array(size)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return bytes
}

function file(over: Partial<FileState> = {}): FileState {
  const data = over.data ?? png()
  return {
    kind: 'file',
    id: FILE,
    purged: false,
    noteId: NOTE_A,
    noteHlc: '',
    name: 'shot.png',
    mime: 'image/png',
    size: data.length,
    createdAt: 1_728_000_000_000,
    data,
    ...over,
  }
}

/** A record as another device's build might have written it, whatever this build would. */
function raw(header: Record<string, unknown>, body: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify(header))
  const out = new Uint8Array(5 + head.length + body.length)
  out[0] = 1
  new DataView(out.buffer).setUint32(1, head.length)
  out.set(head, 5)
  out.set(body, 5 + head.length)
  return out
}

const headerOf = (f: FileState) => {
  const { data: _data, ...header } = f
  return header
}

describe('a file record', () => {
  it('round-trips its fields and its bytes', () => {
    const f = file({ noteHlc: HLC_1, data: png(5000) })
    expect(decodeRecord(FILE, encodeRecord(f))).toEqual(f)
  })

  it('round-trips a tombstone, which holds no name, no type and no bytes', () => {
    const bytes = encodeRecord(tombstoneFile(FILE))
    expect(decodeRecord(FILE, bytes)).toEqual(tombstoneFile(FILE))
    expect(new TextDecoder().decode(bytes)).not.toContain('shot')
  })

  it('refuses what a paste would refuse: not an image, SVG, a wrong type, a wrong size', () => {
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>")
    const cases: [string, Uint8Array][] = [
      ['svg', raw(headerOf(file({ data: svg, mime: 'image/svg+xml', size: svg.length })), svg)],
      ['text', raw(headerOf(file()), new TextEncoder().encode('hello world, not an image at all'))],
      ['mime', raw({ ...headerOf(file()), mime: 'image/jpeg' }, png())],
      ['size', raw({ ...headerOf(file()), size: 41 }, png())],
      ['empty', raw({ ...headerOf(file()), size: 0 }, new Uint8Array(0))],
      ['name', raw({ ...headerOf(file()), name: '' }, png())],
      ['control', raw({ ...headerOf(file()), name: 'a\nb.png' }, png())],
      ['long name', raw({ ...headerOf(file()), name: 'x'.repeat(201) }, png())],
      ['note', raw({ ...headerOf(file()), noteId: 'not-an-id' }, png())],
      ['hlc', raw({ ...headerOf(file()), noteHlc: 'later' }, png())],
      ['purged flag', raw({ ...headerOf(file()), purged: 'no' }, png())],
      ['other id', raw({ ...headerOf(file()), id: NOTE_B }, png())],
    ]
    for (const [, bytes] of cases) {
      expect(() => decodeRecord(FILE, bytes)).toThrow('E_SYNC_RECORD_INVALID')
    }
  })

  it('refuses an image past 10 MiB', () => {
    const big = png(MAX_FILE_BYTES + 1)
    expect(() => decodeRecord(FILE, encodeRecord(file({ data: big })))).toThrow(
      'E_SYNC_RECORD_INVALID',
    )
    const edge = png(MAX_FILE_BYTES)
    expect(decodeRecord(FILE, encodeRecord(file({ data: edge }))).kind).toBe('file')
  })

  it('refuses a tombstone that carries anything', () => {
    const t = headerOf(tombstoneFile(FILE))
    expect(() => decodeRecord(FILE, raw({ ...t, name: 'kept.png' }, new Uint8Array(0)))).toThrow(
      'E_SYNC_RECORD_INVALID',
    )
    expect(() => decodeRecord(FILE, raw(t, png()))).toThrow('E_SYNC_RECORD_INVALID')
    expect(() => decodeRecord(FILE, raw({ ...t, noteId: NOTE_A }, new Uint8Array(0)))).toThrow(
      'E_SYNC_RECORD_INVALID',
    )
  })

  it('has a fingerprint that follows the fields, not the bytes it does not read', () => {
    const a = file()
    expect(fingerprint(a)).toBe(fingerprint(file({ data: new Uint8Array(0), size: 40 })))
    expect(fingerprint(a)).not.toBe(fingerprint(file({ noteId: NOTE_B })))
    expect(fingerprint(a)).not.toBe(fingerprint(tombstoneFile(FILE)))
  })

  it('offers its owner clock to the device clock', () => {
    expect(stampsOf(file({ noteHlc: HLC_2 }))).toEqual([HLC_2])
    expect(stampsOf(file())).toEqual([])
  })
})

describe('merging two copies of a file', () => {
  it('lets the higher HLC decide the note, whichever copy is local', () => {
    const early = file({ noteId: NOTE_A, noteHlc: HLC_1 })
    const late = file({ noteId: NOTE_B, noteHlc: HLC_2 })
    expect(mergeFile(early, late)).toMatchObject({
      record: { noteId: NOTE_B, noteHlc: HLC_2 },
      localNews: false,
      remoteNews: true,
    })
    expect(mergeFile(late, early)).toMatchObject({
      record: { noteId: NOTE_B, noteHlc: HLC_2 },
      localNews: true,
      remoteNews: false,
    })
  })

  it('treats a file never passed on as older than one that was', () => {
    const plain = file()
    const passed = file({ noteId: NOTE_B, noteHlc: HLC_1 })
    expect(mergeFile(plain, passed).record.noteId).toBe(NOTE_B)
    expect(mergeFile(passed, plain).record.noteId).toBe(NOTE_B)
  })

  it('breaks a tie on equal clocks by the greater note ID, the same on both devices', () => {
    const a = file({ noteId: NOTE_A, noteHlc: HLC_1 })
    const b = file({ noteId: NOTE_B, noteHlc: HLC_1 })
    expect(mergeFile(a, b).record.noteId).toBe(NOTE_B)
    expect(mergeFile(b, a).record.noteId).toBe(NOTE_B)
  })

  it('has no news when both agree', () => {
    const a = file({ noteHlc: HLC_1 })
    expect(mergeFile(a, { ...a })).toMatchObject({ localNews: false, remoteNews: false })
  })

  it('lets a purge win over any owner, and be final', () => {
    const live = file({ noteId: NOTE_B, noteHlc: HLC_2 })
    const gone = tombstoneFile(FILE)
    expect(mergeFile(live, gone)).toMatchObject({
      record: { purged: true },
      localNews: false,
      remoteNews: true,
    })
    expect(mergeFile(gone, live)).toMatchObject({
      record: { purged: true },
      localNews: true,
      remoteNews: false,
    })
    expect(mergeFile(gone, gone)).toMatchObject({ localNews: false, remoteNews: false })
  })

  it('does not merge a file with another kind of record', () => {
    expect(() =>
      mergeRecord(file(), {
        kind: 'tag',
        id: FILE,
        name: 't',
        nameHlc: HLC_1,
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
        deletedHlc: '',
        color: null,
        colorHlc: '',
      }),
    ).toThrow('E_SYNC_RECORD_KIND')
  })
})
