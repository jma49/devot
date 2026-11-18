// Kept plugin drawings (ADR 0030): the SVG a plugin drew for a block, kept with its note and synced with it, so a
// device without the plugin shows it while the block is unchanged.
import type { Code, Root } from 'mdast'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import type { Clock } from '../hlc'
import { sha256Hex } from '../sha256'
import type { StorageAdapter } from '../storage'
import { isPluginId, isPluginLanguage } from './manifest'

export type DrawingAppearance = 'light' | 'dark'

export interface KeptDrawing {
  pluginId: string
  language: string
  /** SHA-256 (hex) of the block's content as the preview reads it (`blockHash`). */
  hash: string
  appearance: DrawingAppearance
  /** The drawing as the page rebuilt it; untrusted wherever it is read. */
  svg: string
}

export interface NoteDrawingsRecord {
  noteId: string
  drawings: KeptDrawing[]
  hlc: string
}

export const MAX_DRAWING_BYTES = 256 * 1024
export const MAX_NOTE_DRAWINGS = 32
export const MAX_NOTE_DRAWINGS_BYTES = 1024 * 1024

const HASH = /^[0-9a-f]{64}$/
const encoder = new TextEncoder()
const svgBytes = (svg: string) => encoder.encode(svg).length

/** The block's content as the preview reads it: the code block's text without its last line feed. */
export const blockHash = (content: string): string => sha256Hex(content)

const blockOf = (language: string, hash: string) => `${language}\n${hash}`
const keyOf = (d: KeptDrawing) => `${d.pluginId}\n${d.language}\n${d.hash}\n${d.appearance}`

function isDrawing(value: unknown): value is KeptDrawing {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const d = value as Record<string, unknown>
  return (
    Object.keys(d).length === 5 &&
    isPluginId(d['pluginId']) &&
    isPluginLanguage(d['language']) &&
    typeof d['hash'] === 'string' &&
    HASH.test(d['hash']) &&
    (d['appearance'] === 'light' || d['appearance'] === 'dark') &&
    typeof d['svg'] === 'string' &&
    d['svg'].length > 0 &&
    svgBytes(d['svg']) <= MAX_DRAWING_BYTES
  )
}

/** The list when it is one a note may keep (each drawing well formed, one per key, within the caps); null otherwise. */
export function checkDrawings(value: unknown): KeptDrawing[] | null {
  if (!Array.isArray(value) || value.length > MAX_NOTE_DRAWINGS) return null
  const keys = new Set<string>()
  let bytes = 0
  for (const d of value) {
    if (!isDrawing(d)) return null
    const key = keyOf(d)
    if (keys.has(key)) return null
    keys.add(key)
    bytes += svgBytes(d.svg)
  }
  if (bytes > MAX_NOTE_DRAWINGS_BYTES) return null
  return value.map(({ pluginId, language, hash, appearance, svg }) => ({
    pluginId,
    language,
    hash,
    appearance,
    svg,
  }))
}

// The parse the preview gives a note's blocks, so a block's content is the text its island carries.
let parser: ReturnType<typeof makeParser> | undefined
const makeParser = () =>
  unified().use(remarkParse).use(remarkFrontmatter, ['yaml']).use(remarkGfm).use(remarkMath)

/** Every fenced block with a language in `markdown`, as language and content hash. */
export function drawingBlocks(markdown: string): Set<string> {
  const blocks = new Set<string>()
  if (!markdown.includes('```') && !markdown.includes('~~~')) return blocks
  const walk = (node: { type: string; children?: unknown[] }) => {
    if (node.type === 'code') {
      const code = node as Code
      if (code.lang) blocks.add(blockOf(code.lang, blockHash(code.value)))
      return
    }
    for (const child of node.children ?? []) walk(child as { type: string; children?: unknown[] })
  }
  walk((parser ??= makeParser()).parse(markdown) as Root)
  return blocks
}

/** The drawings whose blocks `blocks` (`drawingBlocks`) still holds. */
export function pruneDrawings(
  drawings: readonly KeptDrawing[],
  blocks: ReadonlySet<string>,
): KeptDrawing[] {
  return drawings.filter((d) => blocks.has(blockOf(d.language, d.hash)))
}

/**
 * The list after keeping `drawing` for a block the note holds: the drawings of blocks gone are dropped, one with the
 * same key replaced. A drawing past the caps is not kept and the others stay. Null when nothing changes.
 */
export function keepDrawing(
  drawings: readonly KeptDrawing[],
  drawing: KeptDrawing,
  blocks: ReadonlySet<string>,
): KeptDrawing[] | null {
  const held = new Set(blocks).add(blockOf(drawing.language, drawing.hash))
  const kept = pruneDrawings(drawings, held)
  const key = keyOf(drawing)
  const same = kept.find((d) => keyOf(d) === key)
  const others = kept.filter((d) => d !== same)
  const next = [...others, drawing]
  const fits =
    isDrawing(drawing) &&
    next.length <= MAX_NOTE_DRAWINGS &&
    next.reduce((sum, d) => sum + svgBytes(d.svg), 0) <= MAX_NOTE_DRAWINGS_BYTES
  if (fits && same?.svg !== drawing.svg) return next
  return kept.length === drawings.length ? null : kept
}

/** The drawing kept for a block in an appearance; one of `pluginId` first, when given. */
export function findDrawing(
  drawings: readonly KeptDrawing[],
  block: { language: string; content: string; appearance: DrawingAppearance; pluginId?: string },
): KeptDrawing | undefined {
  const hash = blockHash(block.content)
  const matches = drawings.filter(
    (d) => d.language === block.language && d.hash === hash && d.appearance === block.appearance,
  )
  return matches.find((d) => d.pluginId === block.pluginId) ?? matches.at(-1)
}

/** The languages a note has drawings in, sorted, for the preview to make islands of. */
export const drawingLanguages = (drawings: readonly KeptDrawing[]): string[] =>
  [...new Set(drawings.map((d) => d.language))].sort()

// One change to a note's drawings at a time, so two blocks drawn at once both stay.
const turns = new WeakMap<StorageAdapter, Map<string, Promise<unknown>>>()

function inTurn<T>(storage: StorageAdapter, noteId: string, run: () => Promise<T>): Promise<T> {
  let notes = turns.get(storage)
  if (!notes) turns.set(storage, (notes = new Map()))
  const before = notes.get(noteId) ?? Promise.resolve()
  const next = before.then(run, run)
  const settled = next.catch(() => undefined)
  notes.set(noteId, settled)
  void settled.then(() => {
    if (notes.get(noteId) === settled) notes.delete(noteId)
  })
  return next
}

/** The note's kept drawings; none for a note without a row. */
export async function noteDrawings(
  storage: StorageAdapter,
  noteId: string,
): Promise<KeptDrawing[]> {
  return (await storage.getNoteDrawings(noteId))?.drawings ?? []
}

/** Keeps a drawing for a live note (`keepDrawing`), under a new clock when the list changes. Answers whether it wrote. */
export function keepNoteDrawing(
  storage: StorageAdapter,
  clock: Clock,
  noteId: string,
  drawing: KeptDrawing,
): Promise<boolean> {
  return inTurn(storage, noteId, async () => {
    const note = await storage.getNote(noteId)
    if (!note) return false
    const row = await storage.getNoteDrawings(noteId)
    const next = keepDrawing(row?.drawings ?? [], drawing, drawingBlocks(note.bodyMd))
    if (!next) return false
    await storage.putNoteDrawings({ noteId, drawings: next, hlc: clock.tick() })
    return true
  })
}

/** Drops the drawings of blocks `bodyMd` no longer holds, under a new clock; answers the list kept. */
export function pruneNoteDrawings(
  storage: StorageAdapter,
  clock: Clock,
  noteId: string,
  bodyMd: string,
): Promise<NoteDrawingsRecord | null> {
  return inTurn(storage, noteId, async () => {
    const row = await storage.getNoteDrawings(noteId)
    if (!row || row.drawings.length === 0) return row
    const kept = pruneDrawings(row.drawings, drawingBlocks(bodyMd))
    if (kept.length === row.drawings.length) return row
    const next = { noteId, drawings: kept, hlc: clock.tick() }
    await storage.putNoteDrawings(next)
    return next
  })
}
