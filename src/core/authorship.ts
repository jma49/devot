// Authorship (docs/adr/0007-authorship-by-yjs-item-ids.md): every agent write adds a record to two
// root maps of the note's Yjs document, `writers` (session -> who) and `writes` (write -> when,
// and which body items it inserted and deleted). Text is attributed by its item IDs, which stay
// the same through merges, sync, garbage collection and restarts, so the records need no anchors.
// Records are untrusted input (another device, devot-mcp, a later build): a reader skips one that
// does not parse and leaves it in the map.

import * as Y from 'yjs'
import { textEdits } from './diff'
import { trimWhitespace } from './text'

const BODY = 'body'
export const WRITERS = 'writers'
export const WRITES = 'writes'

export const WRITER_KINDS = ['mcp', 'http', 'aiEdit'] as const
export type WriterKind = (typeof WRITER_KINDS)[number]

export const WRITE_FIELDS = ['title', 'notebook', 'tags', 'status', 'trash'] as const
export type WriteField = (typeof WRITE_FIELDS)[number]

export const MAX_WRITER_NAME_CHARS = 100
/** The deleted text a note keeps for Undo; beyond it the oldest writes' text is dropped. */
export const MAX_REMOVED_BYTES = 1024 * 1024
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
  /** Undo All took it back: kept only so a later reversal does not restore its text. */
  reversed: boolean
}

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
  return { session: newAuthorshipId(), kind, name: cleanWriterName(name), process }
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
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function readWriter(session: string, value: unknown): Writer | null {
  if (!AUTHORSHIP_ID.test(session) || !isRecord(value) || value['v'] !== RECORD_VERSION) return null
  const { kind, name, process } = value
  if (!isKind(kind) || typeof name !== 'string' || typeof process !== 'string') return null
  return { session, kind, name: cleanWriterName(name), process: process.slice(0, 64) }
}

function readWrite(id: string, value: unknown): AgentWrite | null {
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
  return {
    id,
    session: writer,
    at: at as number,
    ...ranges,
    removed: removed as string | undefined,
    fields: ((fields as string[] | undefined) ?? []).filter(isField),
    created: created === true,
    reversed: value['reversed'] === true,
  }
}

// Each invalid record is logged once per process: readers run on every save and gutter walk. A
// key that is not an ID is text another program chose, and stays out of the log.
const reported = new Set<string>()
function invalid(noteId: string | undefined, key: string) {
  const seen = `${noteId ?? ''} ${key}`
  if (reported.has(seen)) return
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
function readAllWrites(doc: Y.Doc, noteId?: string): AgentWrite[] {
  const found: AgentWrite[] = []
  doc.getMap(WRITES).forEach((value, id) => {
    const write = readWrite(id, value)
    if (write) found.push(write)
    else invalid(noteId, id)
  })
  return found.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
}

/** Oldest first; a write Undo All took back is left out. */
export function readWrites(doc: Y.Doc, noteId?: string): AgentWrite[] {
  return readAllWrites(doc, noteId).filter((write) => !write.reversed)
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

function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      bytes += 4
      i += 1
    } else bytes += 3
  }
  return bytes
}

/** Drops the oldest writes' deleted text until the note keeps at most `max` bytes of it. */
function capRemoved(doc: Y.Doc, max: number) {
  const writes = readAllWrites(doc).filter((w) => w.removed !== undefined)
  let total = writes.reduce((sum, w) => sum + utf8Length(w.removed!), 0)
  const map = doc.getMap(WRITES)
  for (const write of writes) {
    if (total <= max) return
    total -= utf8Length(write.removed!)
    const { removed: _removed, ...kept } = map.get(write.id) as Record<string, unknown>
    map.set(write.id, kept)
  }
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

/** The first span that ends after `clock`. */
function firstAfter(spans: readonly Owned[], clock: number): number {
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
}

/** The steps of the writes in `only` (every write when left out), in document order, from one walk over the body. */
export function reviewSteps(doc: Y.Doc, only?: ReadonlySet<string>, noteId?: string): ReviewStep[] {
  const writes = writesWithWriters(doc, noteId)
    .map(({ write }) => write)
    .filter((write) => !only || only.has(write.id))
  if (writes.length === 0) return []
  const inserted = spansByClient(writes.map((w) => ({ ranges: w.inserted, owner: w.id })))
  const deleted = spansByClient(writes.map((w) => ({ ranges: w.deleted, owner: w.id })))
  const steps: ReviewStep[] = []
  const add = (from: number, to: number, writeId: string, wasDeleted: boolean) => {
    const last = steps[steps.length - 1]
    if (last && last.writeId === writeId && from <= last.to) {
      last.to = Math.max(last.to, to)
      last.deleted ||= wasDeleted
    } else steps.push({ writeId, from, to, deleted: wasDeleted })
  }
  let at = 0
  // oxlint-disable-next-line no-underscore-dangle -- Yjs has no public walk over a text's items with their IDs (ADR 0007, risk 5).
  for (let item = doc.getText(BODY)._start; item; item = item.right) {
    const live = !item.deleted
    if (live && !item.countable) continue
    const spans = (live ? inserted : deleted).get(item.id.client)
    if (spans) {
      const { clock } = item.id
      const end = clock + item.length
      const owners = new Set<string>()
      for (let i = firstAfter(spans, clock); i < spans.length && spans[i]![0] < end; i += 1) {
        const [s, e, owner] = spans[i]!
        if (!live) {
          if (!owners.has(owner)) add(at, at, owner, true)
          owners.add(owner)
          continue
        }
        const a = Math.max(s, clock)
        add(at + a - clock, at + Math.min(e, end) - clock, owner, false)
      }
    }
    if (live) at += item.length
  }
  return steps
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

/**
 * Undo All for one writer (kind and name, across sessions), as one Yjs transaction: each of its
 * writes' deleted text goes back where its deleted items sit, every live character it
 * inserted is deleted, and its records are marked undone. Text the owner or another writer wrote
 * stays, inside the agent's text too, and comes back as theirs. Text the writer deleted that it
 * had itself inserted, or that an undone writer inserted, is not put back.
 */
export function reverseWrites(
  doc: Y.Doc,
  who: { kind: WriterKind; name: string },
  noteId?: string,
): Reversal {
  const writers = readWriters(doc, noteId)
  const all = readAllWrites(doc, noteId)
  const mine = (write: AgentWrite) => {
    const writer = writers.get(write.session)
    return writer !== undefined && writer.kind === who.kind && writer.name === who.name
  }
  const targets = all.filter((write) => !write.reversed && mine(write))
  if (targets.length === 0) return { writes: 0, dropped: 0 }
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
    if (write.reversed) {
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
  for (const list of undone.values()) list.sort((a, b) => a[0] - b[0])
  for (const list of owners.values()) list.sort((a, b) => a[0] - b[0])
  // The text to put back, by the ID it had: each ID once, though two devices may both have deleted it.
  const pieces = new Map<number, { start: number; end: number; text: string; owner?: string }[]>()
  const restored = new Map<number, Span[]>()
  let dropped = 0
  for (const write of [...targets].reverse()) {
    if (write.removed === undefined) {
      if (write.deleted.length > 0) dropped += 1
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
      for (const part of uncovered(span, own).flatMap((p) => uncovered(p, done))) {
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
  doc.transact((tr) => {
    const inserts: { index: number; order: number; text: string; owner?: string }[] = []
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
      // A piece contiguous in clock may span tombstones with live text between them; each part goes back at its own tombstone.
      for (let i = lo; i < list.length && list[i]!.start < end; i += 1) {
        const piece = list[i]!
        const a = Math.max(piece.start, clock)
        const b = Math.min(piece.end, end)
        const part = piece.text.slice(a - piece.start, b - piece.start)
        inserts.push({
          index: at,
          order: (order += 1),
          text: part,
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
    const runs: [number, number][] = []
    walkOwned(text, insertedIndex, (from, length) => runs.push([from, length]))
    for (const [from, length] of runs.reverse()) text.delete(from, length)
    const writes = doc.getMap(WRITES)
    for (const [id, ranges] of extended) {
      const raw = writes.get(id)
      if (!isRecord(raw)) continue
      const write = readWrite(id, raw)
      if (write)
        writes.set(id, { ...raw, ids: packRanges([...write.inserted, ...ranges], write.deleted) })
    }
    for (const write of targets) {
      const raw = writes.get(write.id)
      // The deleted text is of no use once undone, and would count against the cap and push a live writer's out.
      if (isRecord(raw)) {
        const { removed: _removed, ...kept } = raw
        writes.set(write.id, { ...kept, reversed: true })
      }
    }
  })
  return { writes: targets.length, dropped }
}

/** Clear Authorship: deletes every entry of both maps in one transaction; returns how many writes there were. */
export function clearAuthorship(doc: Y.Doc): number {
  const writes = doc.getMap(WRITES)
  const writers = doc.getMap(WRITERS)
  const count = writes.size
  if (count === 0 && writers.size === 0) return 0
  doc.transact(() => {
    for (const key of [...writes.keys()]) writes.delete(key)
    for (const key of [...writers.keys()]) writers.delete(key)
  })
  return count
}
