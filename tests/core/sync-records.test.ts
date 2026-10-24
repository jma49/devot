import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { BODY } from '../../src/core'
import {
  bodyPrint,
  decodeRecord,
  encodeRecord,
  fingerprint,
  mergeBook,
  mergeNote,
  mergeTag,
  textOf,
  tombstone,
  type BookState,
  type NoteState,
  type TagState,
} from '../../src/core/sync/records'

const ID = '0192a6f0-0000-7000-8000-000000000001'
const TAG = '0192a6f0-0000-7000-8000-0000000000aa'
const hlc = (ms: number, node = 'mac') => `${String(ms).padStart(16, '0')}-0000-${node}`

const stateOf = (doc: Y.Doc) => Y.encodeStateAsUpdate(doc)

function textDoc(text: string, client = 1) {
  const d = new Y.Doc()
  d.clientID = client
  d.getText(BODY).insert(0, text)
  return d
}

function note(patch: Partial<NoteState> = {}): NoteState {
  return {
    kind: 'note',
    id: ID,
    purged: false,
    title: 'Plan',
    titleHlc: hlc(1),
    bookId: null,
    bookHlc: '',
    status: 'none',
    statusHlc: '',
    pinned: false,
    pinnedHlc: '',
    createdAt: 1,
    updatedAt: 2,
    datesHlc: '',
    deletedAt: null,
    deletedHlc: '',
    bodyHlc: hlc(1),
    tags: [],
    ydoc: stateOf(textDoc('Hello\n')),
    ...patch,
  }
}

describe('sync records', () => {
  it('round-trip through their bytes', () => {
    const record = note({ tags: [{ tagId: TAG, present: true, hlc: hlc(3) }], pinned: true })
    expect(decodeRecord(ID, encodeRecord(record))).toEqual(record)
    const book: BookState = {
      kind: 'book',
      id: ID,
      name: 'Work',
      nameHlc: hlc(1),
      parentId: null,
      parentHlc: '',
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      deletedHlc: '',
      sortKey: 'a0',
      sortKeyHlc: hlc(1),
      icon: 'symbol.from.a.later.catalog',
      iconColor: 'teal',
      iconHlc: hlc(2),
    }
    expect(decodeRecord(ID, encodeRecord(book))).toEqual(book)
    const stone = tombstone(ID, 5, hlc(5))
    expect(decodeRecord(ID, encodeRecord(stone))).toEqual(stone)
  })

  it('refuse bytes that are not a record of that ID', () => {
    const bytes = encodeRecord(note())
    expect(() => decodeRecord('0192a6f0-0000-7000-8000-000000000002', bytes)).toThrow(
      'E_SYNC_RECORD_INVALID',
    )
    expect(() => decodeRecord(ID, bytes.subarray(0, 8))).toThrow('E_SYNC_RECORD_INVALID')
    expect(() => decodeRecord(ID, encodeRecord(note({ titleHlc: '' })))).toThrow(
      'E_SYNC_RECORD_INVALID',
    )
    expect(() => decodeRecord(ID, encodeRecord(note({ bookId: TAG, bookHlc: '' })))).toThrow(
      'E_SYNC_RECORD_INVALID',
    )
    expect(() => decodeRecord(ID, new Uint8Array([2, 0, 0, 0, 0]))).toThrow('E_SYNC_RECORD_INVALID')
  })

  it('fingerprint the content, not the bytes of the Yjs state', () => {
    const a = textDoc('Hello\n')
    const copy = new Y.Doc()
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(a))
    copy.getText(BODY).insert(0, '')
    expect(bodyPrint(stateOf(copy))).toBe(bodyPrint(stateOf(a)))
    expect(fingerprint(note({ ydoc: stateOf(copy) }))).toBe(fingerprint(note({ ydoc: stateOf(a) })))
    a.getText(BODY).delete(0, 1)
    expect(bodyPrint(stateOf(a))).not.toBe(bodyPrint(stateOf(copy)))
    expect(fingerprint(note({ title: 'Other' }))).not.toBe(fingerprint(note()))
  })
})

describe('merging a note', () => {
  it('applies both bodies to one document and takes each field’s newer value', () => {
    const base = textDoc('Hello\n')
    const mine = new Y.Doc()
    mine.clientID = 2
    Y.applyUpdate(mine, stateOf(base))
    mine.getText(BODY).insert(0, 'Mine. ')
    const theirs = new Y.Doc()
    theirs.clientID = 3
    Y.applyUpdate(theirs, stateOf(base))
    theirs.getText(BODY).insert(5, ' there')
    const merged = mergeNote(
      note({
        ydoc: stateOf(mine),
        title: 'Mine',
        titleHlc: hlc(5),
        pinned: true,
        pinnedHlc: hlc(2),
      }),
      note({
        ydoc: stateOf(theirs),
        title: 'Theirs',
        titleHlc: hlc(4),
        status: 'active',
        statusHlc: hlc(3),
      }),
    )
    expect(textOf(merged.record.ydoc)).toBe('Mine. Hello there\n')
    expect(merged.record).toMatchObject({ title: 'Mine', pinned: true, status: 'active' })
    expect(merged).toMatchObject({ localNews: true, remoteNews: true, bothEdited: true })
  })

  it('has nothing to write or push for the same copy', () => {
    const merged = mergeNote(note(), note())
    expect(merged).toMatchObject({ localNews: false, remoteNews: false, bothEdited: false })
  })

  it('brings a note out of the Trash for a later edit, the same way on both sides', () => {
    const trashed = note({ deletedAt: 9, deletedHlc: hlc(9) })
    const edited = note({ bodyHlc: hlc(10), ydoc: stateOf(textDoc('Hello again\n', 4)) })
    const here = mergeNote(trashed, edited).record
    const there = mergeNote(edited, trashed).record
    expect(here).toMatchObject({ deletedAt: null, deletedHlc: hlc(10) })
    expect(fingerprint(here)).toBe(fingerprint(there))
    expect(mergeNote(note({ bodyHlc: hlc(8) }), trashed).record.deletedAt).toBe(9)
  })

  it('lets a purge win over any edit', () => {
    const stone = tombstone(ID, 7, hlc(7))
    const merged = mergeNote(note({ bodyHlc: hlc(20), titleHlc: hlc(20) }), stone)
    expect(merged.record.purged).toBe(true)
    expect(merged).toMatchObject({ remoteNews: true, localNews: false })
    expect(mergeNote(stone, note())).toMatchObject({ localNews: true, remoteNews: false })
  })

  it('keeps the newer membership of each tag', () => {
    const merged = mergeNote(
      note({ tags: [{ tagId: TAG, present: true, hlc: hlc(2) }] }),
      note({ tags: [{ tagId: TAG, present: false, hlc: hlc(3) }] }),
    )
    expect(merged.record.tags).toEqual([{ tagId: TAG, present: false, hlc: hlc(3) }])
    expect(merged).toMatchObject({ localNews: false, remoteNews: true })
  })
})

describe('merging notebooks and tags', () => {
  const book = (patch: Partial<BookState>): BookState => ({
    kind: 'book',
    id: ID,
    name: 'Work',
    nameHlc: hlc(1),
    parentId: null,
    parentHlc: '',
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    deletedHlc: '',
    sortKey: 'a0',
    sortKeyHlc: '',
    icon: null,
    iconColor: null,
    iconHlc: '',
    ...patch,
  })

  it('takes each field’s newer value, and the greater key at equal clocks', () => {
    const merged = mergeBook(
      book({ name: 'Office', nameHlc: hlc(3), sortKey: 'a0' }),
      book({ deletedAt: 4, deletedHlc: hlc(4), sortKey: 'b0' }),
    )
    expect(merged.record).toMatchObject({ name: 'Office', deletedAt: 4, sortKey: 'b0' })
    expect(merged).toMatchObject({ localNews: true, remoteNews: true })
  })

  it('merges tags by field', () => {
    const tag = (patch: Partial<TagState>): TagState => ({
      kind: 'tag',
      id: ID,
      name: 'daily',
      nameHlc: hlc(1),
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      deletedHlc: '',
      color: null,
      colorHlc: '',
      ...patch,
    })
    const merged = mergeTag(
      tag({ color: 'red', colorHlc: hlc(2) }),
      tag({ name: 'every day', nameHlc: hlc(3) }),
    )
    expect(merged.record).toMatchObject({ name: 'every day', color: 'red' })
  })
})
