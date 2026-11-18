// Authorship (docs/adr/0007-authorship-by-yjs-item-ids.md): every agent write adds a record to two
// root maps of the note's Yjs document, `writers` (session -> who) and `writes` (write -> when,
// and which body items it inserted and deleted). Text is attributed by its item IDs, which stay
// the same through merges, sync, garbage collection and restarts, so the records need no anchors.
// Undo All marks a write in `undone` and adds the ranges it puts back to their owners in
// `restored`, and an undone write whose deleted text came back in `putBack`, each under a key of
// its own: a Y.Map keeps one of two concurrent sets of a key, so no reader depends on a record
// being set again after its write.
// Records are untrusted input (another device, an outside writer, a later build): a reader skips one that
// does not parse and leaves it in the map.

import * as Y from 'yjs'
import { textEdits } from './diff'
import { isRecord } from './isRecord'
import { trimWhitespace, utf8Length } from './text'

const BODY = 'body'
export const WRITERS = 'writers'
export const WRITES = 'writes'
export const UNDONE = 'undone'
export const RESTORED = 'restored'
export const PUT_BACK = 'putBack'

export const WRITER_KINDS = ['mcp', 'http', 'aiEdit'] as const
export type WriterKind = (typeof WRITER_KINDS)[number]

const WRITE_FIELDS = ['title', 'notebook', 'tags', 'status', 'trash'] as const
export type WriteField = (typeof WRITE_FIELDS)[number]

export const MAX_WRITER_NAME_CHARS = 100
/** The deleted text a note keeps for Undo; beyond it the oldest writes' text is dropped. */
const MAX_REMOVED_BYTES = 1024 * 1024
/** The most `agent_writes` rows a note sends to storage, the newest (note_put refuses more). */
export const MAX_AGENT_WRITE_ROWS = 10_000

/** 64 random bits in base64url. */
export const AUTHORSHIP_ID = /^[A-Za-z0-9_-]{11}$/

const RECORD_VERSION = 1

/** One session of one client. */
export interface Writer {
  session: string
  kind: WriterKind
  name: string
  /** The HLC node ID of the process that wrote. */
  process: string
}

export interface IdRange {
  client: number
  clock: number
  length: number
}

export interface AgentWrite {
  id: string
  session: string
  at: number
  /** In document order as the write left the text. */
  inserted: IdRange[]
  /** In document order as the text was before the write. */
  deleted: IdRange[]
  /** The deleted text, in the order of `deleted`; undefined when it was dropped or nothing was deleted. */
  removed: string | undefined
  fields: WriteField[]
  created: boolean
  /** `reversed`: Undo All took it back, kept only so a later reversal does not restore its text; `dropped`: its deleted text was dropped. */
  state: WriteState
  /** Undo put its deleted text back, so a later Undo of a write that deleted the same items leaves them alone. */
  putBack?: true
}

export type WriteState = 'live' | 'dropped' | 'reversed'

/** What storage's derived `agent_writes` index holds of a write. */
export interface AgentWriteRow {
  writeId: string
  kind: WriterKind
  name: string
  at: number
  created: boolean
}

export type Log = (code: string, ...ids: string[]) => void

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export function newAuthorshipId(
  random: (length: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): string {
  let out = ''
  let value = 0
  let bits = 0
  for (const byte of random(8)) {
    value = ((value << 8) | byte) & 0x3fff
    bits += 8
    while (bits >= 6) {
      bits -= 6
      out += B64URL[(value >> bits) & 63]
    }
  }
  return out + B64URL[(value << (6 - bits)) & 63]
}

// Control, line and paragraph separators, and the bidirectional controls that could make a name
// read as another (ADR 0007, risk 4). The Rust store refuses the same (valid_writer_name), and a
// lone surrogate, which no Rust string holds.
const UNSHOWN = /[\p{Cc}\p{Cs}\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/gu

const HAS_UNSHOWN = new RegExp(UNSHOWN.source, 'u')

/** Storage refuses a name cleanWriterName could not give. */
export function validWriterName(name: string): boolean {
  return [...name].length <= MAX_WRITER_NAME_CHARS && !HAS_UNSHOWN.test(name)
}

/** One line without control characters, at most MAX_WRITER_NAME_CHARS code points. */
export function cleanWriterName(name: string): string {
  const line = trimWhitespace(name.replace(UNSHOWN, ' ').replace(/\s+/g, ' '))
  const chars = [...line]
  return chars.length > MAX_WRITER_NAME_CHARS
    ? trimWhitespace(chars.slice(0, MAX_WRITER_NAME_CHARS).join(''))
    : line
}

export function newWriter(kind: WriterKind, name: string, process: string): Writer {
  return {
    session: newAuthorshipId(),
    kind,
    name: cleanWriterName(name),
    process,
  }
}

function writeVarUint(out: number[], value: number) {
  let n = value
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80)
    n = Math.floor(n / 0x80)
  }
  out.push(n)
}

/**
 * Varuints: the clients the ranges name, the count of inserted ranges, then each range as
 * `(client's place in that list, clock, length)`, the inserted ones first. A client ID takes five
 * bytes, and a write's ranges mostly name few clients.
 */
export function packRanges(inserted: readonly IdRange[], deleted: readonly IdRange[]): Uint8Array {
  const ranges = [...inserted, ...deleted]
  const clients = [...new Set(ranges.map((r) => r.client))]
  const place = new Map(clients.map((client, i) => [client, i]))
  const out: number[] = []
  writeVarUint(out, clients.length)
  for (const client of clients) writeVarUint(out, client)
  writeVarUint(out, inserted.length)
  for (const range of ranges) {
    writeVarUint(out, place.get(range.client)!)
    writeVarUint(out, range.clock)
    writeVarUint(out, range.length)
  }
  return Uint8Array.from(out)
}

export function unpackRanges(
  bytes: Uint8Array,
): { inserted: IdRange[]; deleted: IdRange[] } | null {
  let at = 0
  const read = (): number | null => {
    let value = 0
    let scale = 1
    for (;;) {
      if (at >= bytes.length || scale > 2 ** 49) return null
      const byte = bytes[at]!
      at += 1
      value += (byte & 0x7f) * scale
      if (byte < 0x80) return value
      scale *= 0x80
    }
  }
  const clientCount = read()
  if (clientCount === null || clientCount > bytes.length) return null
  const clients: number[] = []
  for (let i = 0; i < clientCount; i += 1) {
    const client = read()
    if (client === null || client > 0xffffffff) return null
    clients.push(client)
  }
  const count = read()
  if (count === null) return null
  const ranges: IdRange[] = []
  while (at < bytes.length) {
    const index = read()
    const clock = read()
    const length = read()
    if (index === null || clock === null || length === null || length === 0) return null
    const client = clients[index]
    if (client === undefined) return null
    ranges.push({ client, clock, length })
  }
  if (count > ranges.length) return null
  return { inserted: ranges.slice(0, count), deleted: ranges.slice(count) }
}

const isKind = (value: unknown): value is WriterKind =>
  (WRITER_KINDS as readonly unknown[]).includes(value)
const isField = (value: unknown): value is WriteField =>
  (WRITE_FIELDS as readonly unknown[]).includes(value)
function readWriter(session: string, value: unknown): Writer | null {
  if (!AUTHORSHIP_ID.test(session) || !isRecord(value) || value['v'] !== RECORD_VERSION) return null
  const { kind, name, process } = value
  if (!isKind(kind) || typeof name !== 'string' || typeof process !== 'string') return null
  return {
    session,
    kind,
    name: cleanWriterName(name),
    process: process.slice(0, 64),
  }
}

function readWrite(
  id: string,
  value: unknown,
  undone: boolean,
  putBack: boolean,
): AgentWrite | null {
  if (!AUTHORSHIP_ID.test(id) || !isRecord(value) || value['v'] !== RECORD_VERSION) return null
  const { writer, at, ids, removed, fields, created } = value
  if (typeof writer !== 'string' || !AUTHORSHIP_ID.test(writer)) return null
  if (!Number.isSafeInteger(at) || (at as number) < 0 || !(ids instanceof Uint8Array)) return null
  const ranges = unpackRanges(ids)
  if (!ranges) return null
  if (removed !== undefined) {
    const length = ranges.deleted.reduce((sum, r) => sum + r.length, 0)
    if (typeof removed !== 'string' || removed.length !== length) return null
  }
  if (
    fields !== undefined &&
    !(Array.isArray(fields) && fields.every((f) => typeof f === 'string'))
  )
    return null
  if (created !== undefined && typeof created !== 'boolean') return null
  // An earlier build marked an undone write in its record.
  const state: WriteState =
    undone || value['reversed'] === true
      ? 'reversed'
      : removed === undefined && ranges.deleted.length > 0
        ? 'dropped'
        : 'live'
  return {
    id,
    session: writer,
    at: at as number,
    ...ranges,
    removed: removed as string | undefined,
    fields: ((fields as string[] | undefined) ?? []).filter(isField),
    created: created === true,
    state,
    ...(state === 'reversed' && putBack ? { putBack: true as const } : {}),
  }
}

/** A `restored` entry: ranges Undo All put back as write `write`'s. */
function readRestored(value: unknown): { write: string; inserted: IdRange[] } | null {
  if (!isRecord(value) || value['v'] !== RECORD_VERSION) return null
  const { write, ids } = value
  if (typeof write !== 'string' || !AUTHORSHIP_ID.test(write) || !(ids instanceof Uint8Array))
    return null
  const ranges = unpackRanges(ids)
  return ranges && ranges.deleted.length === 0 ? { write, inserted: ranges.inserted } : null
}

/** Invalid records remembered as logged; past it the memory starts again, so a long run stays bounded. */
export const MAX_REPORTED_INVALID = 1_000

// Each invalid record is logged once per process: readers run on every save and gutter walk. A
// key that is not an ID is text another program chose, and stays out of the log.
const reported = new Set<string>()
function invalid(noteId: string | undefined, key: string) {
  const seen = `${noteId ?? ''} ${key}`
  if (reported.has(seen)) return
  if (reported.size >= MAX_REPORTED_INVALID) reported.clear()
  reported.add(seen)
  const ids = [...(noteId ? [noteId] : []), ...(AUTHORSHIP_ID.test(key) ? [key] : [])]
  console.warn('W_AUTHORSHIP_RECORD_INVALID', ...ids)
}

export function readWriters(doc: Y.Doc, noteId?: string): Map<string, Writer> {
  const found = new Map<string, Writer>()
  doc.getMap(WRITERS).forEach((value, session) => {
    const writer = readWriter(session, value)
    if (writer) found.set(session, writer)
    else invalid(noteId, session)
  })
  return found
}

/** Every write, undone ones included (reverseWrites needs their inserted ranges). */
export function readAllWrites(doc: Y.Doc, noteId?: string): AgentWrite[] {
  const undone = doc.getMap(UNDONE)
  const putBack = doc.getMap(PUT_BACK)
  const restored = new Map<string, IdRange[]>()
  doc.getMap(RESTORED).forEach((value, key) => {
    const entry = readRestored(value)
    if (!entry) return invalid(noteId, key)
    const list = restored.get(entry.write)
    if (list) list.push(...entry.inserted)
    else restored.set(entry.write, entry.inserted)
  })
  const found: AgentWrite[] = []
  doc.getMap(WRITES).forEach((value, id) => {
    const write = readWrite(id, value, undone.get(id) === true, putBack.get(id) === true)
    if (!write) return invalid(noteId, id)
    write.inserted.push(...(restored.get(id) ?? []))
    found.push(write)
  })
  return found.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
}

/** Oldest first; a write Undo All took back is left out. */
export function readWrites(doc: Y.Doc, noteId?: string): AgentWrite[] {
  return readAllWrites(doc, noteId).filter((write) => write.state !== 'reversed')
}

/** Each write with its writer; one whose writer is unknown is left out. */
export function writesWithWriters(
  doc: Y.Doc,
  noteId?: string,
): { write: AgentWrite; writer: Writer }[] {
  const writers = readWriters(doc, noteId)
  return readWrites(doc, noteId).flatMap((write) => {
    const writer = writers.get(write.session)
    return writer ? [{ write, writer }] : []
  })
}

export function agentWriteRows(doc: Y.Doc, noteId?: string): AgentWriteRow[] {
  return writesWithWriters(doc, noteId)
    .reverse()
    .slice(0, MAX_AGENT_WRITE_ROWS)
    .map(({ write, writer }) => ({
      writeId: write.id,
      kind: writer.kind,
      name: writer.name,
      at: write.at,
      created: write.created,
    }))
}

/** Whether two row lists are the same, so a save leaves the index alone. */
export function sameRows(a: readonly AgentWriteRow[] | undefined, b: readonly AgentWriteRow[]) {
  if (!a || a.length !== b.length) return false
  return a.every((row, i) => {
    const other = b[i]!
    return (
      row.writeId === other.writeId &&
      row.kind === other.kind &&
      row.name === other.name &&
      row.at === other.at &&
      row.created === other.created
    )
  })
}

function pushRange(ranges: IdRange[], client: number, clock: number, length: number) {
  const last = ranges[ranges.length - 1]
  if (last && last.client === client && last.clock + last.length === clock) last.length += length
  else ranges.push({ client, clock, length })
}

type Span = [start: number, end: number]

function mergedSpans(items: readonly { clock: number; len: number }[]): Span[] {
  const sorted = items.map((d): Span => [d.clock, d.clock + d.len]).sort((a, b) => a[0] - b[0])
  const out: Span[] = []
  for (const span of sorted) {
    const last = out[out.length - 1]
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1])
    else out.push(span)
  }
  return out
}

/** The body items `tr` inserted and deleted so far, read before the transaction ends and garbage collection drops the deleted content. */
function captureWrite(text: Y.Text, tr: Y.Transaction) {
  const own = tr.doc.clientID
  const from = tr.beforeState.get(own) ?? 0
  const deletedNow = new Map<number, Span[]>()
  for (const [client, items] of tr.deleteSet.clients) deletedNow.set(client, mergedSpans(items))
  const inserted: IdRange[] = []
  const deleted: IdRange[] = []
  let removed = ''
  // oxlint-disable-next-line no-underscore-dangle -- Yjs has no public walk over a text's items with their IDs (ADR 0007, risk 5).
  for (let item = text._start; item; item = item.right) {
    const { client, clock } = item.id
    const end = clock + item.length
    if (!item.deleted) {
      if (client === own && end > from && item.countable) {
        const start = Math.max(clock, from)
        pushRange(inserted, client, start, end - start)
      }
      continue
    }
    if (!(item.content instanceof Y.ContentString)) continue
    const spans = deletedNow.get(client)
    if (!spans) continue
    for (const [s, e] of spans) {
      if (e <= clock) continue
      if (s >= end) break
      const a = Math.max(s, clock)
      const b = Math.min(e, end)
      pushRange(deleted, client, a, b - a)
      removed += item.content.str.slice(a - clock, b - clock)
    }
  }
  return { inserted, deleted, removed }
}

/** Drops the oldest writes' deleted text until the note keeps at most `max` bytes of it. */
function capRemoved(doc: Y.Doc, max: number) {
  const writes = readAllWrites(doc).filter((w) => w.removed !== undefined)
  let total = writes.reduce((sum, w) => sum + utf8Length(w.removed!), 0)
  for (const write of writes) {
    if (total <= max) return
    total -= utf8Length(write.removed!)
    dropRemoved(doc, write.id)
  }
}

/** Sets a record again without its deleted text: every device that does it sets the same record. */
function dropRemoved(doc: Y.Doc, id: string) {
  const map = doc.getMap(WRITES)
  const raw = map.get(id)
  if (!isRecord(raw) || raw['removed'] === undefined) return
  const { removed: _removed, ...kept } = raw
  map.set(id, kept)
}

export interface AgentEdit {
  writer: Writer
  at: number
  /** The new body, applied as the text difference (textEdits); undefined leaves the body alone. */
  markdown?: string
  fields?: readonly WriteField[]
  created?: boolean
  /** For tests of the cap; MAX_REMOVED_BYTES otherwise. */
  maxRemovedBytes?: number
}

/**
 * Applies an agent's write and its record as one Yjs transaction. Returns the write's ID, or null
 * when it would change nothing (no body change, no field, not a new note).
 */
export function applyAgentEdit(doc: Y.Doc, edit: AgentEdit): string | null {
  const text = doc.getText(BODY)
  const edits = edit.markdown === undefined ? [] : textEdits(text.toString(), edit.markdown)
  const fields = [...new Set(edit.fields ?? [])].filter(isField)
  if (edits.length === 0 && fields.length === 0 && !edit.created) return null
  const id = newAuthorshipId()
  doc.transact((tr) => {
    // From the end, so the offsets still ahead stay right.
    for (const change of [...edits].reverse()) {
      if (change.end > change.start) text.delete(change.start, change.end - change.start)
      if (change.text) text.insert(change.start, change.text)
    }
    const { inserted, deleted, removed } = captureWrite(text, tr)
    const { session, kind, name, process } = edit.writer
    const writers = doc.getMap(WRITERS)
    const known = readWriter(session, writers.get(session))
    if (!known || known.kind !== kind || known.name !== name || known.process !== process) {
      writers.set(session, { v: RECORD_VERSION, kind, name, process })
    }
    doc.getMap(WRITES).set(id, {
      v: RECORD_VERSION,
      writer: session,
      at: edit.at,
      ids: packRanges(inserted, deleted),
      ...(removed ? { removed } : {}),
      ...(fields.length > 0 ? { fields } : {}),
      ...(edit.created ? { created: true } : {}),
    })
    capRemoved(doc, edit.maxRemovedBytes ?? MAX_REMOVED_BYTES)
  })
  return id
}

/**
 * Records what `tr`, a local transaction that has just ended, did to the body as write `id` of
 * a known session: undoing Undo All puts the writes' text back with new item IDs. Call it from
 * `afterTransaction`, before garbage collection drops the deleted text. Returns whether it recorded.
 */
export function recordTransaction(
  doc: Y.Doc,
  tr: Y.Transaction,
  write: { id: string; session: string; at: number },
): boolean {
  if (!readWriters(doc).has(write.session)) return false
  const { inserted, deleted, removed } = captureWrite(doc.getText(BODY), tr)
  if (inserted.length === 0 && deleted.length === 0) return false
  doc.transact(() => {
    doc.getMap(WRITES).set(write.id, {
      v: RECORD_VERSION,
      writer: write.session,
      at: write.at,
      ids: packRanges(inserted, deleted),
      ...(removed ? { removed } : {}),
    })
    capRemoved(doc, MAX_REMOVED_BYTES)
  })
  return true
}

export interface AuthoredRun {
  /** UTF-16 offsets in the body as it is now. */
  from: number
  to: number
  writeId: string
}

type Owned = [start: number, end: number, owner: string]
type DeletedOwned = [start: number, end: number, owner: string, text: string | undefined]

/** Per client, the spans of `ranges` in clock order, each with its owner. */
function spansByClient(owned: readonly { ranges: readonly IdRange[]; owner: string }[]) {
  const index = new Map<number, Owned[]>()
  for (const { ranges, owner } of owned) {
    for (const r of ranges) {
      const list = index.get(r.client)
      const span: Owned = [r.clock, r.clock + r.length, owner]
      if (list) list.push(span)
      else index.set(r.client, [span])
    }
  }
  for (const list of index.values()) list.sort((a, b) => a[0] - b[0])
  return index
}

function deletedSpansByClient(writes: readonly AgentWrite[]) {
  const index = new Map<number, DeletedOwned[]>()
  for (const write of writes) {
    let offset = 0
    for (const r of write.deleted) {
      const text = write.removed?.slice(offset, offset + r.length)
      offset += r.length
      const list = index.get(r.client)
      const span: DeletedOwned = [r.clock, r.clock + r.length, write.id, text]
      if (list) list.push(span)
      else index.set(r.client, [span])
    }
  }
  for (const list of index.values()) list.sort((a, b) => a[0] - b[0])
  return index
}

/** The first span that ends after `clock`. */
function firstAfter(spans: readonly [number, number, ...unknown[]][], clock: number): number {
  let lo = 0
  let hi = spans.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (spans[mid]![1] <= clock) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Calls `visit` for every live character run of the body that falls in `index`, with its offset. */
function walkOwned(
  text: Y.Text,
  index: Map<number, Owned[]>,
  visit: (from: number, length: number, owner: string) => void,
) {
  let at = 0
  // oxlint-disable-next-line no-underscore-dangle -- Yjs has no public walk over a text's items with their IDs (ADR 0007, risk 5).
  for (let item = text._start; item; item = item.right) {
    if (item.deleted || !item.countable) continue
    const spans = index.get(item.id.client)
    if (spans) {
      const { clock } = item.id
      const end = clock + item.length
      for (let i = firstAfter(spans, clock); i < spans.length && spans[i]![0] < end; i += 1) {
        const [s, e, owner] = spans[i]!
        const a = Math.max(s, clock)
        visit(at + a - clock, Math.min(e, end) - a, owner)
      }
    }
    at += item.length
  }
}

/** Which ranges of the current body each write inserted, in document order; the rest is the owner's. */
export function attribute(doc: Y.Doc, noteId?: string): AuthoredRun[] {
  const writes = writesWithWriters(doc, noteId)
  const index = spansByClient(
    writes.map(({ write }) => ({ ranges: write.inserted, owner: write.id })),
  )
  const runs: AuthoredRun[] = []
  walkOwned(doc.getText(BODY), index, (from, length, writeId) => {
    const last = runs[runs.length - 1]
    if (last && last.writeId === writeId && last.to === from) last.to += length
    else runs.push({ from, to: from + length, writeId })
  })
  return runs
}

/** One place Review Changes shows: what a write inserted there, where it deleted text, or both side by side. */
export interface ReviewStep {
  writeId: string
  /** UTF-16 offsets in the body as it is now; equal for a deletion point alone. */
  from: number
  to: number
  /** The write deleted text here. */
  deleted: boolean
  /** The Yjs ID (`client:clock`) of the step's first item: stays the same while text elsewhere changes. */
  anchor: string
  /** The Yjs ID of the step's last item: changes when the step grows, as when the text between two of its runs goes. */
  end: string
  /** The text the write deleted at this step, when still kept. */
  removed?: string
}

/**
 * The steps of the writes in `only` (every write when left out), in document order, from one walk
 * over the body. Every live write is walked, so a step ends where another write's text or deletion
 * point sits, whichever writes are asked for, and a step's key never depends on the others' review.
 */
export function reviewSteps(doc: Y.Doc, only?: ReadonlySet<string>, noteId?: string): ReviewStep[] {
  const writes = writesWithWriters(doc, noteId).map(({ write }) => write)
  if (writes.length === 0 || (only && !writes.some((write) => only.has(write.id)))) return []
  const inserted = spansByClient(writes.map((w) => ({ ranges: w.inserted, owner: w.id })))
  const deleted = deletedSpansByClient(writes)
  const steps: ReviewStep[] = []
  const add = (
    from: number,
    to: number,
    writeId: string,
    wasDeleted: boolean,
    anchor: string,
    end: string,
    removedText?: string,
  ) => {
    const last = steps[steps.length - 1]
    if (last && last.writeId === writeId && from <= last.to) {
      last.to = Math.max(last.to, to)
      last.deleted ||= wasDeleted
      last.end = end
      if (removedText) last.removed = `${last.removed ?? ''}${removedText}`
    } else {
      steps.push({
        writeId,
        from,
        to,
        deleted: wasDeleted,
        anchor,
        end,
        ...(removedText ? { removed: removedText } : {}),
      })
    }
  }
  let at = 0
  // oxlint-disable-next-line no-underscore-dangle -- Yjs has no public walk over a text's items with their IDs (ADR 0007, risk 5).
  for (let item = doc.getText(BODY)._start; item; item = item.right) {
    const live = !item.deleted
    if (live && !item.countable) continue
    if (!live) {
      const spans = deleted.get(item.id.client)
      if (spans) {
        const { clock } = item.id
        const end = clock + item.length
        const byOwner = new Map<string, { anchor: string; end: string; text: string | undefined }>()
        for (let i = firstAfter(spans, clock); i < spans.length && spans[i]![0] < end; i += 1) {
          const [s, e, owner, slice] = spans[i]!
          const a = Math.max(s, clock)
          const b = Math.min(e, end)
          const part = slice?.slice(a - s, b - s)
          const prev = byOwner.get(owner)
          const last = `${item.id.client}:${b - 1}`
          if (prev) {
            prev.end = last
            if (part) prev.text = `${prev.text ?? ''}${part}`
          } else {
            byOwner.set(owner, {
              anchor: `${item.id.client}:${a}`,
              end: last,
              text: part,
            })
          }
        }
        for (const [owner, { anchor, end: last, text }] of byOwner)
          add(at, at, owner, true, anchor, last, text)
      }
      continue
    }
    const spans = inserted.get(item.id.client)
    if (spans) {
      const { clock } = item.id
      const end = clock + item.length
      for (let i = firstAfter(spans, clock); i < spans.length && spans[i]![0] < end; i += 1) {
        const [s, e, owner] = spans[i]!
        const a = Math.max(s, clock)
        const b = Math.min(e, end)
        add(
          at + a - clock,
          at + b - clock,
          owner,
          false,
          `${item.id.client}:${a}`,
          `${item.id.client}:${b - 1}`,
        )
      }
    }
    at += item.length
  }
  return only ? steps.filter((step) => only.has(step.writeId)) : steps
}

/** The parts of `span` no span of `taken` covers; `taken` holds disjoint spans in order. */
function uncovered(span: Span, taken: readonly Span[]): Span[] {
  const out: Span[] = []
  let start = span[0]
  for (const [s, e] of taken) {
    if (e <= start) continue
    if (s >= span[1]) break
    if (s > start) out.push([start, s])
    start = Math.max(start, e)
  }
  if (start < span[1]) out.push([start, span[1]])
  return out
}

/** The parts of `span` each of `owners` covers, with its write, and the rest; `owners` holds disjoint spans in order. */
function splitOwned(span: Span, owners: readonly Owned[]): [number, number, string | undefined][] {
  const out: [number, number, string | undefined][] = []
  let start = span[0]
  for (const [s, e, owner] of owners) {
    if (e <= start) continue
    if (s >= span[1]) break
    if (s > start) out.push([start, s, undefined])
    const a = Math.max(s, start)
    const b = Math.min(e, span[1])
    if (b > a) out.push([a, b, owner])
    start = Math.max(start, e)
  }
  if (start < span[1]) out.push([start, span[1], undefined])
  return out
}

function addSpan(list: Span[], span: Span) {
  list.push(span)
  list.sort((a, b) => a[0] - b[0])
}

export interface Reversal {
  /** How many writes were undone. */
  writes: number
  /** Of those, how many deleted text that was dropped (MAX_REMOVED_BYTES): only what they inserted was taken out. */
  dropped: number
}

type Piece = { start: number; end: number; text: string; owner?: string }
type MapEntry = { map: string; key: string; had: boolean; value: unknown }
type DeletedPiece = {
  client: number
  clock: number
  text: string
  write: string | undefined
}

/** What Restore needs to take back one Undo: what its transaction changed, and the document as it left it. */
export interface UndoneWrites {
  /** The writes it took back, newest first. */
  writes: readonly string[]
  /** The document right after the Undo; Restore refuses once it differs. */
  after: Y.Snapshot
  /** The body items the Undo inserted: text it put back. */
  inserted: readonly IdRange[]
  /** The text the Undo deleted, by the ID of its first item, with the write that had inserted it. */
  deleted: readonly DeletedPiece[]
  /** Each authorship map entry the Undo set, in order, with whether it was there before and its value then. */
  entries: readonly MapEntry[]
}

/**
 * Undo All for one writer (its kind and every name it has gone by, across sessions), as one Yjs transaction: each of its
 * writes' deleted text goes back where its deleted items sit, every live character it
 * inserted is deleted, and its records are marked undone. Text the owner or another writer wrote
 * stays, inside the agent's text too, and comes back as theirs. Text the writer deleted that it
 * had itself inserted, or that an undone writer inserted, is not put back.
 */
function reverseTargetWrites(
  doc: Y.Doc,
  all: readonly AgentWrite[],
  writers: ReadonlyMap<string, Writer>,
  targets: readonly AgentWrite[],
): { reversal: Reversal; undone: UndoneWrites | undefined } {
  if (targets.length === 0) return { reversal: { writes: 0, dropped: 0 }, undone: undefined }
  const targetIds = new Set(targets.map((write) => write.id))
  const insertedIndex = spansByClient(targets.map((w) => ({ ranges: w.inserted, owner: w.id })))
  const insertedSpans = new Map<number, Span[]>()
  for (const [client, spans] of insertedIndex) {
    insertedSpans.set(
      client,
      spans.map(([s, e]): Span => [s, e]),
    )
  }
  // Text an already undone write inserted must not come back when another writer is undone.
  const undone = new Map<number, Span[]>()
  // Inserted text of the other live writers: what comes back stays theirs, so their Undo All still takes it out.
  const owners = new Map<number, Owned[]>()
  for (const write of all) {
    if (write.state === 'reversed') {
      for (const range of write.inserted) {
        const list = undone.get(range.client) ?? []
        list.push([range.clock, range.clock + range.length])
        undone.set(range.client, list)
      }
    } else if (!targetIds.has(write.id) && writers.has(write.session)) {
      for (const range of write.inserted) {
        const list = owners.get(range.client) ?? []
        list.push([range.clock, range.clock + range.length, write.id])
        owners.set(range.client, list)
      }
    }
  }
  // Text an earlier Undo already put back, perhaps on another device: each ID comes back once across Undos too.
  const back = new Map<number, Span[]>()
  for (const write of all) {
    if (!write.putBack) continue
    for (const range of write.deleted) {
      const list = back.get(range.client) ?? []
      list.push([range.clock, range.clock + range.length])
      back.set(range.client, list)
    }
  }
  for (const [client, list] of back) {
    back.set(client, mergedSpans(list.map(([start, end]) => ({ clock: start, len: end - start }))))
  }
  for (const list of undone.values()) list.sort((a, b) => a[0] - b[0])
  for (const list of owners.values()) list.sort((a, b) => a[0] - b[0])
  // The text to put back, by the ID it had: each ID once, though two devices may both have deleted it.
  const pieces = new Map<number, Piece[]>()
  const restored = new Map<number, Span[]>()
  let dropped = 0
  for (const write of [...targets].reverse()) {
    if (write.removed === undefined) {
      if (write.state === 'dropped') dropped += 1
      continue
    }
    let offset = 0
    for (const range of write.deleted) {
      const slice = write.removed.slice(offset, offset + range.length)
      offset += range.length
      const span: Span = [range.clock, range.clock + range.length]
      const own = insertedSpans.get(range.client) ?? []
      const done = restored.get(range.client) ?? []
      const gone = undone.get(range.client) ?? []
      const theirs = owners.get(range.client) ?? []
      const already = back.get(range.client) ?? []
      for (const part of uncovered(span, own)
        .flatMap((p) => uncovered(p, done))
        .flatMap((p) => uncovered(p, already))) {
        const list = pieces.get(range.client) ?? []
        for (const kept of uncovered(part, gone)) {
          for (const [a, b, owner] of splitOwned(kept, theirs)) {
            list.push({
              start: a,
              end: b,
              text: slice.slice(a - range.clock, b - range.clock),
              ...(owner === undefined ? {} : { owner }),
            })
          }
        }
        pieces.set(range.client, list)
        addSpan(done, part)
      }
      restored.set(range.client, done)
    }
  }
  for (const list of pieces.values()) list.sort((a, b) => a.start - b.start)
  const text = doc.getText(BODY)
  const entries: MapEntry[] = []
  const set = (name: string, key: string, value: unknown) => {
    const map = doc.getMap(name)
    entries.push({ map: name, key, had: map.has(key), value: map.get(key) })
    map.set(key, value)
  }
  let inserted: IdRange[] = []
  const deleted: DeletedPiece[] = []
  doc.transact((tr) => {
    const extended = putBackPieces(text, tr, pieces)
    const runs: [number, number][] = []
    walkOwned(text, insertedIndex, (from, length) => runs.push([from, length]))
    for (const [from, length] of runs.reverse()) text.delete(from, length)
    addRestored(extended, set)
    const writes = doc.getMap(WRITES)
    for (const write of targets) {
      set(UNDONE, write.id, true)
      if (write.removed !== undefined) set(PUT_BACK, write.id, true)
      // The deleted text is of no use once undone, and would count against the cap and push a live writer's out.
      // `reversed` is what an earlier build on another device reads; this build reads `undone`.
      const raw = writes.get(write.id)
      if (!isRecord(raw)) continue
      const { removed: _removed, ...kept } = raw
      if (raw['removed'] !== undefined || raw['reversed'] !== true)
        set(WRITES, write.id, { ...kept, reversed: true })
    }
    const changed = captureWrite(text, tr)
    inserted = changed.inserted
    let offset = 0
    for (const range of changed.deleted) {
      const slice = changed.removed.slice(offset, offset + range.length)
      offset += range.length
      const span: Span = [range.clock, range.clock + range.length]
      for (const [a, b, write] of splitOwned(span, insertedIndex.get(range.client) ?? [])) {
        deleted.push({
          client: range.client,
          clock: a,
          text: slice.slice(a - range.clock, b - range.clock),
          write,
        })
      }
    }
  })
  return {
    reversal: { writes: targets.length, dropped },
    undone: {
      writes: [...targets].reverse().map((write) => write.id),
      after: Y.snapshot(doc),
      inserted,
      deleted,
      entries,
    },
  }
}

/**
 * Puts each piece back where its deleted items sit, in `tr`: a piece contiguous in clock may span tombstones with live
 * text between them, and each part goes back at its own tombstone. Returns the ranges each owner's pieces now have.
 */
function putBackPieces(
  text: Y.Text,
  tr: Y.Transaction,
  pieces: ReadonlyMap<number, readonly Piece[]>,
): Map<string, IdRange[]> {
  const inserts: {
    index: number
    order: number
    text: string
    owner?: string
  }[] = []
  let at = 0
  let order = 0
  // oxlint-disable-next-line no-underscore-dangle -- Yjs has no public walk over a text's items with their IDs (ADR 0007, risk 5).
  for (let item = text._start; item; item = item.right) {
    if (!item.deleted) {
      if (item.countable) at += item.length
      continue
    }
    const list = pieces.get(item.id.client)
    if (!list) continue
    const { clock } = item.id
    const end = clock + item.length
    let lo = 0
    let hi = list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (list[mid]!.end <= clock) lo = mid + 1
      else hi = mid
    }
    for (let i = lo; i < list.length && list[i]!.start < end; i += 1) {
      const piece = list[i]!
      const a = Math.max(piece.start, clock)
      const b = Math.min(piece.end, end)
      inserts.push({
        index: at,
        order: (order += 1),
        text: piece.text.slice(a - piece.start, b - piece.start),
        ...(piece.owner === undefined ? {} : { owner: piece.owner }),
      })
    }
  }
  const client = tr.doc.clientID
  let clock = tr.beforeState.get(client) ?? 0
  const extended = new Map<string, IdRange[]>()
  for (const piece of inserts.sort((a, b) => b.index - a.index || b.order - a.order)) {
    text.insert(piece.index, piece.text)
    if (piece.owner !== undefined) {
      const list = extended.get(piece.owner) ?? []
      pushRange(list, client, clock, piece.text.length)
      extended.set(piece.owner, list)
    }
    clock += piece.text.length
  }
  return extended
}

/**
 * Puts each piece back right after the deleted items it was, in `tr`, so it sits among the tombstones beside it as
 * the text it brings back did: inserting by offset would put it before them, and move another write's deletion point
 * across it. Returns the ranges each owner's pieces now have.
 */
function insertAfterTombstones(
  text: Y.Text,
  tr: Y.Transaction,
  pieces: ReadonlyMap<number, readonly Piece[]>,
): Map<string, IdRange[]> {
  const parts: {
    client: number
    last: number
    text: string
    owner?: string
  }[] = []
  const bounds = new Map(
    [...pieces].map(([client, list]) => [client, list.map((p): Span => [p.start, p.end])]),
  )
  // oxlint-disable-next-line no-underscore-dangle -- Yjs has no public walk over a text's items with their IDs (ADR 0007, risk 5).
  for (let item = text._start; item; item = item.right) {
    const list = item.deleted ? pieces.get(item.id.client) : undefined
    if (!list) continue
    const { clock } = item.id
    const end = clock + item.length
    for (
      let i = firstAfter(bounds.get(item.id.client)!, clock);
      i < list.length && list[i]!.start < end;
      i += 1
    ) {
      const piece = list[i]!
      const a = Math.max(piece.start, clock)
      const b = Math.min(piece.end, end)
      parts.push({
        client: item.id.client,
        last: b - 1,
        text: piece.text.slice(a - piece.start, b - piece.start),
        ...(piece.owner === undefined ? {} : { owner: piece.owner }),
      })
    }
  }
  const { store } = tr.doc
  const own = tr.doc.clientID
  const extended = new Map<string, IdRange[]>()
  for (const part of parts) {
    const left = Y.getItemCleanEnd(tr, store, Y.createID(part.client, part.last))
    const clock = Y.getState(store, own)
    const { right } = left
    const id = Y.createID(own, clock)
    new Y.Item(
      id,
      left,
      left.lastId,
      right,
      right?.id ?? null,
      text,
      null,
      new Y.ContentString(part.text),
    ).integrate(tr, 0)
    if (part.owner !== undefined) {
      const list = extended.get(part.owner) ?? []
      pushRange(list, own, clock, part.text.length)
      extended.set(part.owner, list)
    }
  }
  // Its search markers cache offsets that the items above moved; Y.Text builds them again.
  // oxlint-disable-next-line no-underscore-dangle -- the cache has no public reset (ADR 0007, risk 5).
  text._searchMarker?.splice(0)
  return extended
}

function addRestored(
  extended: ReadonlyMap<string, IdRange[]>,
  set: (map: string, key: string, value: unknown) => void,
) {
  for (const [id, ranges] of extended) {
    set(RESTORED, newAuthorshipId(), {
      v: RECORD_VERSION,
      write: id,
      ids: packRanges(ranges, []),
    })
  }
}

/**
 * Undo All for one writer (its kind and every name it has gone by, across sessions), as one Yjs transaction: each of its
 * writes' deleted text goes back where its deleted items sit, every live character it
 * inserted is deleted, and its records are marked undone. Text the owner or another writer wrote
 * stays, inside the agent's text too, and comes back as theirs. Text the writer deleted that it
 * had itself inserted, or that an undone writer inserted, is not put back.
 */
export function reverseWrites(
  doc: Y.Doc,
  who: { kind: WriterKind; names: readonly string[] },
  noteId?: string,
): Reversal {
  const writers = readWriters(doc, noteId)
  const all = readAllWrites(doc, noteId)
  const names = new Set(who.names)
  const targets = all.filter((write) => {
    if (write.state === 'reversed') return false
    const writer = writers.get(write.session)
    return writer !== undefined && writer.kind === who.kind && names.has(writer.name)
  })
  return reverseTargetWrites(doc, all, writers, targets).reversal
}

/** `writeId` and every later live write that deleted text one of them inserted, oldest first. */
function groupOf(
  all: readonly AgentWrite[],
  writers: ReadonlyMap<string, Writer>,
  writeId: string,
): AgentWrite[] {
  const live = all.filter((write) => write.state !== 'reversed' && writers.has(write.session))
  const start = live.findIndex((write) => write.id === writeId)
  if (start < 0) return []
  const group = [live[start]!]
  const inserted: IdRange[] = [...live[start]!.inserted]
  const touches = (r: IdRange) =>
    inserted.some(
      (own) =>
        own.client === r.client &&
        own.clock < r.clock + r.length &&
        r.clock < own.clock + own.length,
    )
  for (const later of live.slice(start + 1)) {
    if (!later.deleted.some(touches)) continue
    group.push(later)
    inserted.push(...later.inserted)
  }
  return group
}

/**
 * The writes Undo of `writeId` takes back, newest first: it, and every later write that rewrote text it (or one of
 * those) inserted, since undoing it alone would leave the later write's text in pieces.
 */
export function undoGroup(doc: Y.Doc, writeId: string, noteId?: string): string[] {
  return groupOf(readAllWrites(doc, noteId), readWriters(doc, noteId), writeId)
    .map((write) => write.id)
    .reverse()
}

/**
 * Undo one write (`writeId`) and the later writes `undoGroup` adds to it, leaving other writes (seen historical
 * writes included) intact. Text another writer wrote that these writes deleted comes back attributed to that writer.
 */
export function reverseWrite(doc: Y.Doc, writeId: string, noteId?: string): Reversal {
  return undoWrite(doc, writeId, noteId).reversal
}

/** `reverseWrite`, with what `restoreWrites` needs to take the Undo back; undefined when it undid nothing. */
export function undoWrite(
  doc: Y.Doc,
  writeId: string,
  noteId?: string,
): { reversal: Reversal; undone: UndoneWrites | undefined } {
  const writers = readWriters(doc, noteId)
  const all = readAllWrites(doc, noteId)
  return reverseTargetWrites(doc, all, writers, groupOf(all, writers, writeId))
}

/**
 * Restore after an Undo, as one Yjs transaction: the text the Undo put back goes again, the text it took out comes back
 * with new items that `restored` gives to the writes that had it, and every record the Undo set is as it was, so the
 * writes are live again. Returns false, changing nothing, when the document changed since the Undo.
 */
export function restoreWrites(doc: Y.Doc, undone: UndoneWrites): boolean {
  if (!Y.equalSnapshots(Y.snapshot(doc), undone.after)) return false
  const text = doc.getText(BODY)
  const pieces = new Map<number, Piece[]>()
  for (const { client, clock, text: part, write } of undone.deleted) {
    const list = pieces.get(client) ?? []
    list.push({
      start: clock,
      end: clock + part.length,
      text: part,
      ...(write === undefined ? {} : { owner: write }),
    })
    pieces.set(client, list)
  }
  for (const list of pieces.values()) list.sort((a, b) => a.start - b.start)
  doc.transact((tr) => {
    const runs: [number, number][] = []
    walkOwned(text, spansByClient([{ ranges: undone.inserted, owner: '' }]), (from, length) =>
      runs.push([from, length]),
    )
    for (const [from, length] of runs.reverse()) text.delete(from, length)
    const extended = insertAfterTombstones(text, tr, pieces)
    for (const { map, key, had, value } of [...undone.entries].reverse()) {
      if (had) doc.getMap(map).set(key, value)
      else doc.getMap(map).delete(key)
    }
    addRestored(extended, (map, key, value) => doc.getMap(map).set(key, value))
  })
  return true
}

/** Clear Authorship: deletes every entry of the maps in one transaction; returns how many writes there were. */
export function clearAuthorship(doc: Y.Doc): number {
  const maps = [WRITES, WRITERS, UNDONE, RESTORED, PUT_BACK].map((name) => doc.getMap(name))
  const count = maps[0]!.size
  if (maps.every((map) => map.size === 0)) return 0
  doc.transact(() => {
    for (const map of maps) for (const key of [...map.keys()]) map.delete(key)
  })
  return count
}
