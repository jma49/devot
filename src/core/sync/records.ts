// Sync records (docs/adr/0002-sync-latest-state-per-record.md, Records): what a device sends the
// relay for a note, a notebook or a tag, and how two copies of one record merge. Rust seals the
// bytes; this file only builds, reads and merges them.
//
// A note carries its body's whole Yjs state, its metadata fields with the HLC of each one's last
// change, its tag memberships (each with its HLC), `bodyHlc` (when its body last changed, so the
// Trash can be ordered against edits) and `purged`. A purged note is a tombstone: its ID, `purged`
// and its deletion, nothing else. Notebooks and tags carry fields and HLCs only. Allow AI Access
// is not synced: each device decides what devot-mcp may read.

import * as Y from 'yjs'
import { agentWriteRows } from '../authorship'
import { UUID_V7 } from '../ids'
import { BODY, seedClient } from '../notes'
import { sha256Hex } from '../sha256'
import { NOTE_STATUSES, type NoteStatus } from '../storage'

export type SyncKind = 'note' | 'book' | 'tag'

export interface NoteTagState {
  tagId: string
  present: boolean
  hlc: string
}

export interface NoteState {
  kind: 'note'
  id: string
  purged: boolean
  title: string
  titleHlc: string
  bookId: string | null
  bookHlc: string
  status: NoteStatus
  statusHlc: string
  pinned: boolean
  pinnedHlc: string
  createdAt: number
  updatedAt: number
  datesHlc: string
  deletedAt: number | null
  /** '' when the note was never moved to the Trash or back. */
  deletedHlc: string
  bodyHlc: string
  /** By tag ID. */
  tags: NoteTagState[]
  /** Empty for a tombstone. */
  ydoc: Uint8Array
}

export interface BookState {
  kind: 'book'
  id: string
  name: string
  nameHlc: string
  parentId: string | null
  parentHlc: string
  createdAt: number
  updatedAt: number
  deletedAt: number | null
  deletedHlc: string
  sortKey: string
  sortKeyHlc: string
  /** As another device wrote it: a name or colour this build does not know is kept here. */
  icon: string | null
  iconColor: string | null
  iconHlc: string
}

export interface TagState {
  kind: 'tag'
  id: string
  name: string
  nameHlc: string
  createdAt: number
  updatedAt: number
  deletedAt: number | null
  deletedHlc: string
  color: string | null
  colorHlc: string
}

export type SyncRecord = NoteState | BookState | TagState

export interface Merged<T extends SyncRecord> {
  record: T
  /** The merge holds something the remote copy lacks: this device must push it. */
  localNews: boolean
  /** The merge holds something the local copy lacks: this device must write it. */
  remoteNews: boolean
}

export interface MergedNote extends Merged<NoteState> {
  /** The merge changes the local body, which held text of this device's (not a welcome nobody edited). */
  bodyChanged: boolean
  /** Both bodies held changes the other lacked. */
  bothEdited: boolean
}

const FORMAT = 1
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

/** `format (1) || header length (u32, big-endian) || JSON header || Yjs state`. */
export function encodeRecord(record: SyncRecord): Uint8Array {
  const { ydoc, ...header } = record.kind === 'note' ? record : { ...record, ydoc: undefined }
  const head = encoder.encode(JSON.stringify(header))
  const body = ydoc ?? new Uint8Array(0)
  const out = new Uint8Array(5 + head.length + body.length)
  out[0] = FORMAT
  new DataView(out.buffer).setUint32(1, head.length)
  out.set(head, 5)
  out.set(body, 5 + head.length)
  return out
}

const invalid = () => new Error('E_SYNC_RECORD_INVALID')

const HLC = /^\d{16}-[0-9a-f]{4}-[a-z0-9]{1,32}$/
const isHlc = (v: unknown): v is string => typeof v === 'string' && HLC.test(v)
const isOptionalHlc = (v: unknown): v is string => v === '' || isHlc(v)
const isId = (v: unknown): v is string => typeof v === 'string' && UUID_V7.test(v)
const isTime = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const isName = (v: unknown): v is string => typeof v === 'string' && v.length <= 4000
const isNullable = <T>(v: unknown, test: (v: unknown) => v is T): v is T | null =>
  v === null || test(v)
const isShort = (v: unknown): v is string => typeof v === 'string' && v.length <= 200

function readNote(h: Record<string, unknown>, ydoc: Uint8Array): NoteState {
  const tags = h['tags']
  if (!Array.isArray(tags)) throw invalid()
  const tagStates = tags.map((t: unknown): NoteTagState => {
    const tag = t as Record<string, unknown>
    if (typeof t !== 'object' || t === null || !isId(tag['tagId']) || !isHlc(tag['hlc'])) {
      throw invalid()
    }
    if (typeof tag['present'] !== 'boolean') throw invalid()
    return { tagId: tag['tagId'], present: tag['present'], hlc: tag['hlc'] }
  })
  const purged = h['purged']
  const status = h['status']
  const valid =
    typeof purged === 'boolean' &&
    isName(h['title']) &&
    (purged ? isOptionalHlc(h['titleHlc']) : isHlc(h['titleHlc'])) &&
    isNullable(h['bookId'], isId) &&
    isOptionalHlc(h['bookHlc']) &&
    (h['bookId'] === null || h['bookHlc'] !== '') &&
    NOTE_STATUSES.includes(status as NoteStatus) &&
    isOptionalHlc(h['statusHlc']) &&
    typeof h['pinned'] === 'boolean' &&
    isOptionalHlc(h['pinnedHlc']) &&
    isTime(h['createdAt']) &&
    isTime(h['updatedAt']) &&
    (h['updatedAt'] as number) >= (h['createdAt'] as number) &&
    isOptionalHlc(h['datesHlc']) &&
    isNullable(h['deletedAt'], isTime) &&
    isOptionalHlc(h['deletedHlc']) &&
    isOptionalHlc(h['bodyHlc']) &&
    (purged ? ydoc.length === 0 : ydoc.length > 0)
  if (!valid) throw invalid()
  return {
    kind: 'note',
    id: h['id'] as string,
    purged,
    title: h['title'] as string,
    titleHlc: h['titleHlc'] as string,
    bookId: h['bookId'] as string | null,
    bookHlc: h['bookHlc'] as string,
    status: status as NoteStatus,
    statusHlc: h['statusHlc'] as string,
    pinned: h['pinned'] as boolean,
    pinnedHlc: h['pinnedHlc'] as string,
    createdAt: h['createdAt'] as number,
    updatedAt: h['updatedAt'] as number,
    datesHlc: h['datesHlc'] as string,
    deletedAt: h['deletedAt'] as number | null,
    deletedHlc: h['deletedHlc'] as string,
    bodyHlc: h['bodyHlc'] as string,
    tags: byTag(tagStates),
    ydoc,
  }
}

function readBook(h: Record<string, unknown>): BookState {
  const valid =
    isName(h['name']) &&
    isOptionalHlc(h['nameHlc']) &&
    isNullable(h['parentId'], isId) &&
    isOptionalHlc(h['parentHlc']) &&
    isTime(h['createdAt']) &&
    isTime(h['updatedAt']) &&
    isNullable(h['deletedAt'], isTime) &&
    isOptionalHlc(h['deletedHlc']) &&
    isShort(h['sortKey']) &&
    isOptionalHlc(h['sortKeyHlc']) &&
    isNullable(h['icon'], isShort) &&
    isNullable(h['iconColor'], isShort) &&
    isOptionalHlc(h['iconHlc'])
  if (!valid) throw invalid()
  return {
    kind: 'book',
    id: h['id'] as string,
    name: h['name'] as string,
    nameHlc: h['nameHlc'] as string,
    parentId: h['parentId'] as string | null,
    parentHlc: h['parentHlc'] as string,
    createdAt: h['createdAt'] as number,
    updatedAt: h['updatedAt'] as number,
    deletedAt: h['deletedAt'] as number | null,
    deletedHlc: h['deletedHlc'] as string,
    sortKey: h['sortKey'] as string,
    sortKeyHlc: h['sortKeyHlc'] as string,
    icon: h['icon'] as string | null,
    iconColor: h['iconColor'] as string | null,
    iconHlc: h['iconHlc'] as string,
  }
}

function readTag(h: Record<string, unknown>): TagState {
  const valid =
    isName(h['name']) &&
    isOptionalHlc(h['nameHlc']) &&
    isTime(h['createdAt']) &&
    isTime(h['updatedAt']) &&
    isNullable(h['deletedAt'], isTime) &&
    isOptionalHlc(h['deletedHlc']) &&
    isNullable(h['color'], isShort) &&
    isOptionalHlc(h['colorHlc'])
  if (!valid) throw invalid()
  return {
    kind: 'tag',
    id: h['id'] as string,
    name: h['name'] as string,
    nameHlc: h['nameHlc'] as string,
    createdAt: h['createdAt'] as number,
    updatedAt: h['updatedAt'] as number,
    deletedAt: h['deletedAt'] as number | null,
    deletedHlc: h['deletedHlc'] as string,
    color: h['color'] as string | null,
    colorHlc: h['colorHlc'] as string,
  }
}

/** Reads what `encodeRecord` wrote for record `id`; throws E_SYNC_RECORD_INVALID for anything else. */
export function decodeRecord(id: string, bytes: Uint8Array): SyncRecord {
  if (bytes.length < 5 || bytes[0] !== FORMAT) throw invalid()
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1)
  if (length > bytes.length - 5) throw invalid()
  let header: unknown
  try {
    header = JSON.parse(decoder.decode(bytes.subarray(5, 5 + length)))
  } catch {
    throw invalid()
  }
  if (typeof header !== 'object' || header === null || Array.isArray(header)) throw invalid()
  const h = header as Record<string, unknown>
  if (h['id'] !== id || !isId(id)) throw invalid()
  const rest = bytes.slice(5 + length)
  if (h['kind'] === 'note') return readNote(h, rest)
  if (rest.length > 0) throw invalid()
  if (h['kind'] === 'book') return readBook(h)
  if (h['kind'] === 'tag') return readTag(h)
  throw invalid()
}

const docOf = (state: Uint8Array) => {
  const doc = new Y.Doc()
  if (state.length > 0) Y.applyUpdate(doc, state)
  return doc
}

/** What a body holds, the same for equal content however its state was encoded: its state vector and delete set. */
const printOf = (doc: Y.Doc) => sha256Hex(Y.encodeSnapshot(Y.snapshot(doc)))

export const bodyPrint = (state: Uint8Array): string => (state.length ? printOf(docOf(state)) : '')

const byTag = (tags: readonly NoteTagState[]) =>
  [...tags].sort((a, b) => (a.tagId < b.tagId ? -1 : a.tagId > b.tagId ? 1 : 0))

/** Equal for records that hold the same fields and the same body, whatever the bytes of its state. */
export function fingerprint(record: SyncRecord): string {
  if (record.kind !== 'note') return sha256Hex(JSON.stringify(record))
  const { ydoc, ...fields } = record
  return sha256Hex(`${JSON.stringify({ ...fields, tags: byTag(fields.tags) })}\n${bodyPrint(ydoc)}`)
}

export const textOf = (state: Uint8Array): string => docOf(state).getText(BODY).toString()

/** What storage derives from a note's state: its text and its agent_writes rows (ADR 0007). */
export function bodyFacts(id: string, state: Uint8Array) {
  const doc = docOf(state)
  return { bodyMd: doc.getText(BODY).toString(), agentWrites: agentWriteRows(doc, id) }
}

/** The seed's client when the body is a first-launch note nobody edited (written by NoteService.seed alone). */
function untouchedSeed(id: string, doc: Y.Doc): number | null {
  const clients = [...Y.decodeStateVector(Y.encodeStateVector(doc)).keys()]
  if (clients.length !== 1) return null
  const text = doc.getText(BODY).toString()
  return seedClient(id, text) === clients[0] ? clients[0] : null
}

/** Deletes every character `client` wrote: the other copy's text stays, and the lineage of both goes on. */
function dropClient(doc: Y.Doc, client: number) {
  const text = doc.getText(BODY)
  const runs: [number, number][] = []
  let at = 0
  // oxlint-disable-next-line no-underscore-dangle -- Yjs has no public walk over a text's items with their clients.
  for (let item = text._start; item; item = item.right) {
    if (item.deleted || !item.countable) continue
    if (item.id.client === client) runs.push([at, item.length])
    at += item.length
  }
  doc.transact(() => {
    for (const [from, length] of runs.reverse()) text.delete(from, length)
  })
}

const later = (a: string, b: string) => (b > a ? b : a)

interface Field<T> {
  value: T
  hlc: string
}
const newer = <T>(local: Field<T>, remote: Field<T>): Field<T> =>
  remote.hlc > local.hlc ? remote : local

function mergeTags(local: readonly NoteTagState[], remote: readonly NoteTagState[]) {
  const tags = new Map(local.map((t) => [t.tagId, t]))
  for (const tag of remote) {
    const mine = tags.get(tag.tagId)
    if (!mine || tag.hlc > mine.hlc) tags.set(tag.tagId, tag)
  }
  return byTag([...tags.values()])
}

const tagsAhead = (of: readonly NoteTagState[], than: readonly NoteTagState[]) => {
  const other = new Map(than.map((t) => [t.tagId, t.hlc]))
  return of.some((t) => t.hlc > (other.get(t.tagId) ?? ''))
}

const NOTE_HLCS = [
  'titleHlc',
  'bookHlc',
  'statusHlc',
  'pinnedHlc',
  'datesHlc',
  'deletedHlc',
  'bodyHlc',
] as const

const hlcsAhead = (of: NoteState, than: NoteState) =>
  NOTE_HLCS.some((key) => of[key] > than[key]) || tagsAhead(of.tags, than.tags)

export function tombstone(id: string, deletedAt: number, deletedHlc: string): NoteState {
  return {
    kind: 'note',
    id,
    purged: true,
    title: '',
    titleHlc: '',
    bookId: null,
    bookHlc: '',
    status: 'none',
    statusHlc: '',
    pinned: false,
    pinnedHlc: '',
    createdAt: 0,
    updatedAt: 0,
    datesHlc: '',
    deletedAt,
    deletedHlc,
    bodyHlc: '',
    tags: [],
    ydoc: new Uint8Array(0),
  }
}

/**
 * Body: both Yjs states in one document, which never conflicts. A first-launch note nobody edited
 * that the other copy never saw gives way to the other copy (the same welcome seeded by two builds
 * would otherwise show both texts). Metadata: per field the higher HLC; dates as storage merges
 * them. The Trash is a field like the others, but a body or title change made after the move to
 * the Trash (by HLC) brings the note back, so an edit never vanishes into another device's Trash.
 * A purge wins over everything and is final.
 */
export function mergeNote(local: NoteState, remote: NoteState): MergedNote {
  if (local.purged || remote.purged) {
    const kept = local.purged ? local : remote
    const deletedHlc = later(local.deletedHlc, remote.deletedHlc)
    return {
      record: tombstone(kept.id, kept.deletedAt ?? remote.deletedAt ?? 0, deletedHlc),
      localNews: local.purged && !remote.purged,
      remoteNews: remote.purged && !local.purged,
      bodyChanged: false,
      bothEdited: false,
    }
  }
  const localDoc = docOf(local.ydoc)
  const remoteDoc = docOf(remote.ydoc)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, local.ydoc)
  Y.applyUpdate(doc, remote.ydoc)
  const localSeed = untouchedSeed(local.id, localDoc)
  const remoteSeed = untouchedSeed(remote.id, remoteDoc)
  const seenBy = (other: Y.Doc, client: number) =>
    Y.decodeStateVector(Y.encodeStateVector(other)).has(client)
  const localGivesWay = localSeed !== null && !seenBy(remoteDoc, localSeed)
  if (localGivesWay) dropClient(doc, localSeed)
  else if (remoteSeed !== null && !seenBy(localDoc, remoteSeed)) dropClient(doc, remoteSeed)
  const merged = printOf(doc)
  const bodyLocalNews = merged !== printOf(remoteDoc)
  const bodyRemoteNews = merged !== printOf(localDoc)

  const title = newer(
    { value: local.title, hlc: local.titleHlc },
    { value: remote.title, hlc: remote.titleHlc },
  )
  const book = newer(
    { value: local.bookId, hlc: local.bookHlc },
    { value: remote.bookId, hlc: remote.bookHlc },
  )
  const status = newer(
    { value: local.status, hlc: local.statusHlc },
    { value: remote.status, hlc: remote.statusHlc },
  )
  const pinned = newer(
    { value: local.pinned, hlc: local.pinnedHlc },
    { value: remote.pinned, hlc: remote.pinnedHlc },
  )
  const deleted = newer(
    { value: local.deletedAt, hlc: local.deletedHlc },
    { value: remote.deletedAt, hlc: remote.deletedHlc },
  )
  const dates =
    remote.datesHlc > local.datesHlc
      ? { createdAt: remote.createdAt, updatedAt: remote.updatedAt, datesHlc: remote.datesHlc }
      : {
          createdAt: local.createdAt,
          updatedAt: Math.max(local.updatedAt, remote.updatedAt),
          datesHlc: local.datesHlc,
        }
  const bodyHlc = later(local.bodyHlc, remote.bodyHlc)
  const edited = later(bodyHlc, title.hlc)
  const back = deleted.value !== null && edited > deleted.hlc
  const record: NoteState = {
    kind: 'note',
    id: local.id,
    purged: false,
    title: title.value,
    titleHlc: title.hlc,
    bookId: book.value,
    bookHlc: book.hlc,
    status: status.value,
    statusHlc: status.hlc,
    pinned: pinned.value,
    pinnedHlc: pinned.hlc,
    ...dates,
    deletedAt: back ? null : deleted.value,
    deletedHlc: back ? edited : deleted.hlc,
    bodyHlc,
    tags: mergeTags(local.tags, remote.tags),
    ydoc: bodyRemoteNews ? Y.encodeStateAsUpdate(doc) : local.ydoc,
  }
  return {
    record,
    localNews: bodyLocalNews || hlcsAhead(record, remote),
    remoteNews: bodyRemoteNews || hlcsAhead(record, local),
    bodyChanged: bodyRemoteNews && !localGivesWay,
    bothEdited: bodyLocalNews && bodyRemoteNews && !localGivesWay,
  }
}

/** Equal clocks (keys given to old notebooks on two devices): the greater key wins, as in storage. */
const sortKeyOf = (local: BookState, remote: BookState): Field<string> =>
  remote.sortKeyHlc > local.sortKeyHlc ||
  (remote.sortKeyHlc === local.sortKeyHlc && remote.sortKey > local.sortKey)
    ? { value: remote.sortKey, hlc: remote.sortKeyHlc }
    : { value: local.sortKey, hlc: local.sortKeyHlc }

const bookAhead = (of: BookState, than: BookState) =>
  of.nameHlc > than.nameHlc ||
  of.parentHlc > than.parentHlc ||
  of.deletedHlc > than.deletedHlc ||
  of.iconHlc > than.iconHlc ||
  of.sortKeyHlc > than.sortKeyHlc ||
  (of.sortKeyHlc === than.sortKeyHlc && of.sortKey > than.sortKey)

export function mergeBook(local: BookState, remote: BookState): Merged<BookState> {
  const name = newer(
    { value: local.name, hlc: local.nameHlc },
    { value: remote.name, hlc: remote.nameHlc },
  )
  const parent = newer(
    { value: local.parentId, hlc: local.parentHlc },
    { value: remote.parentId, hlc: remote.parentHlc },
  )
  const deleted = newer(
    { value: local.deletedAt, hlc: local.deletedHlc },
    { value: remote.deletedAt, hlc: remote.deletedHlc },
  )
  const icon = remote.iconHlc > local.iconHlc ? remote : local
  const sortKey = sortKeyOf(local, remote)
  const record: BookState = {
    kind: 'book',
    id: local.id,
    name: name.value,
    nameHlc: name.hlc,
    parentId: parent.value,
    parentHlc: parent.hlc,
    createdAt: local.createdAt,
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
    deletedAt: deleted.value,
    deletedHlc: deleted.hlc,
    sortKey: sortKey.value,
    sortKeyHlc: sortKey.hlc,
    icon: icon.icon,
    iconColor: icon.iconColor,
    iconHlc: icon.iconHlc,
  }
  return {
    record,
    localNews: bookAhead(record, remote),
    remoteNews: bookAhead(record, local),
  }
}

const tagAhead = (of: TagState, than: TagState) =>
  of.nameHlc > than.nameHlc || of.colorHlc > than.colorHlc || of.deletedHlc > than.deletedHlc

export function mergeTag(local: TagState, remote: TagState): Merged<TagState> {
  const name = newer(
    { value: local.name, hlc: local.nameHlc },
    { value: remote.name, hlc: remote.nameHlc },
  )
  const color = newer(
    { value: local.color, hlc: local.colorHlc },
    { value: remote.color, hlc: remote.colorHlc },
  )
  const deleted = newer(
    { value: local.deletedAt, hlc: local.deletedHlc },
    { value: remote.deletedAt, hlc: remote.deletedHlc },
  )
  const record: TagState = {
    kind: 'tag',
    id: local.id,
    name: name.value,
    nameHlc: name.hlc,
    createdAt: local.createdAt,
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
    deletedAt: deleted.value,
    deletedHlc: deleted.hlc,
    color: color.value,
    colorHlc: color.hlc,
  }
  return { record, localNews: tagAhead(record, remote), remoteNews: tagAhead(record, local) }
}

export function mergeRecord(local: SyncRecord, remote: SyncRecord): Merged<SyncRecord> {
  if (local.kind === 'note' && remote.kind === 'note') return mergeNote(local, remote)
  if (local.kind === 'book' && remote.kind === 'book') return mergeBook(local, remote)
  if (local.kind === 'tag' && remote.kind === 'tag') return mergeTag(local, remote)
  throw new Error('E_SYNC_RECORD_KIND')
}

/** Every HLC a record carries, for the clock to take in before this device writes over them. */
export function stampsOf(record: SyncRecord): string[] {
  if (record.kind === 'note') {
    return [...NOTE_HLCS.map((key) => record[key]), ...record.tags.map((t) => t.hlc)]
  }
  if (record.kind === 'book') {
    return [record.nameHlc, record.parentHlc, record.deletedHlc, record.sortKeyHlc, record.iconHlc]
  }
  return [record.nameHlc, record.colorHlc, record.deletedHlc]
}
