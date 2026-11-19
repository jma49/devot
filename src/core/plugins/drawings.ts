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

// Fields a later build adds are let go, so its drawings still read here (ADR 0030).
function drawingOf(value: unknown): KeptDrawing | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const d = value as Record<string, unknown>
  const { pluginId, language, hash, appearance, svg } = d
  const valid =
    isPluginId(pluginId) &&
    isPluginLanguage(language) &&
    typeof hash === 'string' &&
    HASH.test(hash) &&
    (appearance === 'light' || appearance === 'dark') &&
    typeof svg === 'string' &&
    svg.length > 0 &&
    svgBytes(svg) <= MAX_DRAWING_BYTES
  return valid ? { pluginId, language, hash, appearance, svg } : null
}

const isDrawing = (value: unknown): value is KeptDrawing => drawingOf(value) !== null

/** The list when it is one a note may keep (each drawing well formed, one per key, within the caps); null otherwise. */
export function checkDrawings(value: unknown): KeptDrawing[] | null {
  if (!Array.isArray(value) || value.length > MAX_NOTE_DRAWINGS) return null
  const keys = new Set<string>()
  const list: KeptDrawing[] = []
  let bytes = 0
  for (const item of value) {
    const d = drawingOf(item)
    if (!d || keys.has(keyOf(d))) return null
    keys.add(keyOf(d))
    bytes += svgBytes(d.svg)
    list.push(d)
  }
  return bytes > MAX_NOTE_DRAWINGS_BYTES ? null : list
}

/**
 * A synced list as this build can keep it: a drawing it cannot read or a second one of a key is dropped, not the
 * list, and the ones past the caps are let go. Null when `value` is no list at all.
 */
export function readDrawings(value: unknown): KeptDrawing[] | null {
  if (!Array.isArray(value)) return null
  const keys = new Set<string>()
  const list: KeptDrawing[] = []
  for (const item of value) {
    const d = drawingOf(item)
    if (!d || keys.has(keyOf(d))) continue
    keys.add(keyOf(d))
    list.push(d)
  }
  return withinCaps(list)
}

function withinCaps(list: readonly KeptDrawing[]): KeptDrawing[] {
  const kept: KeptDrawing[] = []
  let bytes = 0
  for (const d of list) {
    const size = svgBytes(d.svg)
    if (kept.length === MAX_NOTE_DRAWINGS || bytes + size > MAX_NOTE_DRAWINGS_BYTES) continue
    kept.push(d)
    bytes += size
  }
  return kept
}

const byKey = (a: KeptDrawing, b: KeptDrawing) => {
  const x = keyOf(a)
  const y = keyOf(b)
  return x < y ? -1 : x > y ? 1 : 0
}

/** Whether two lists hold the same drawings, in any order. */
export function sameDrawings(a: readonly KeptDrawing[], b: readonly KeptDrawing[]): boolean {
  if (a.length !== b.length) return false
  const svgs = new Map(a.map((d) => [keyOf(d), d.svg]))
  return b.every((d) => svgs.get(keyOf(d)) === d.svg)
}

export interface DrawingsField {
  drawings: readonly KeptDrawing[]
  hlc: string
}

/**
 * Two devices' lists of one note, merged by key (ADR 0030): a drawing depends only on its key, so one of a block the
 * merged body holds is kept from either side. One of a block it no longer holds is kept only from the side with the
 * later clock, so a device's prune reaches the others. Within the caps, the drawings of held blocks go first, then
 * by key, so every device picks the same ones. `bodyMd` is read only when a side has drawings.
 */
export function mergeDrawings(
  local: DrawingsField,
  remote: DrawingsField,
  bodyMd: () => string,
): { drawings: KeptDrawing[]; hlc: string } {
  const hlc = remote.hlc > local.hlc ? remote.hlc : local.hlc
  if (local.drawings.length === 0 && remote.drawings.length === 0) return { drawings: [], hlc }
  const blocks = drawingBlocks(bodyMd())
  const held = (d: KeptDrawing) => blocks.has(blockOf(d.language, d.hash))
  const sides = [local, remote].sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0))
  const latest = sides[1]!.hlc
  const chosen = new Map<string, { drawing: KeptDrawing; hlc: string }>()
  for (const side of sides) {
    for (const drawing of side.drawings) {
      if (side.hlc !== latest && !held(drawing)) continue
      const key = keyOf(drawing)
      const had = chosen.get(key)
      const wins =
        !had || side.hlc > had.hlc || (side.hlc === had.hlc && drawing.svg > had.drawing.svg)
      if (wins) chosen.set(key, { drawing, hlc: side.hlc })
    }
  }
  const all = [...chosen.values()].map((c) => c.drawing).sort(byKey)
  const kept = withinCaps([...all.filter(held), ...all.filter((d) => !held(d))])
  return { drawings: kept.sort(byKey), hlc }
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

/**
 * The drawings without those of `plugins` whose blocks `blocks` (`drawingBlocks`) no longer holds. Only a device whose
 * plugin draws prunes that plugin's drawings (ADR 0030); the others keep them.
 */
export function pruneDrawings(
  drawings: readonly KeptDrawing[],
  blocks: ReadonlySet<string>,
  plugins: ReadonlySet<string>,
): KeptDrawing[] {
  return drawings.filter((d) => !plugins.has(d.pluginId) || blocks.has(blockOf(d.language, d.hash)))
}

/**
 * The list after keeping `drawing` for a block the note holds: the drawings of `plugins` (with the drawing's own) of
 * blocks gone are dropped, one with the same key replaced. A drawing past the caps is not kept and the others stay.
 * Null when nothing changes.
 */
export function keepDrawing(
  drawings: readonly KeptDrawing[],
  drawing: KeptDrawing,
  blocks: ReadonlySet<string>,
  plugins: ReadonlySet<string>,
): KeptDrawing[] | null {
  const held = new Set(blocks).add(blockOf(drawing.language, drawing.hash))
  const kept = pruneDrawings(drawings, held, new Set(plugins).add(drawing.pluginId))
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

/**
 * Keeps a drawing for a live note (`keepDrawing`, `plugins` being the ones that draw here), under a new clock when
 * the list changes. Answers whether it wrote.
 */
export function keepNoteDrawing(
  storage: StorageAdapter,
  clock: Clock,
  noteId: string,
  drawing: KeptDrawing,
  plugins: ReadonlySet<string>,
): Promise<boolean> {
  return inTurn(storage, noteId, async () => {
    const note = await storage.getNote(noteId)
    if (!note) return false
    const row = await storage.getNoteDrawings(noteId)
    const next = keepDrawing(row?.drawings ?? [], drawing, drawingBlocks(note.bodyMd), plugins)
    if (!next) return false
    await storage.putNoteDrawings({ noteId, drawings: next, hlc: clock.tick() })
    return true
  })
}

/**
 * Drops the drawings of `plugins` (the ones that draw here) of blocks the note no longer holds, under a new clock;
 * answers the list kept.
 */
export function pruneNoteDrawings(
  storage: StorageAdapter,
  clock: Clock,
  noteId: string,
  plugins: ReadonlySet<string>,
): Promise<NoteDrawingsRecord | null> {
  return inTurn(storage, noteId, async () => {
    const row = await storage.getNoteDrawings(noteId)
    if (!row || !row.drawings.some((d) => plugins.has(d.pluginId))) return row
    const note = await storage.getNote(noteId, { trashed: true })
    if (!note) return row
    const kept = pruneDrawings(row.drawings, drawingBlocks(note.bodyMd), plugins)
    if (kept.length === row.drawings.length) return row
    const next = { noteId, drawings: kept, hlc: clock.tick() }
    await storage.putNoteDrawings(next)
    return next
  })
}
