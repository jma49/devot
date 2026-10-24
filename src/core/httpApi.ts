// The local HTTP API's calls, as the main window's core runs them. Rust
// (src-tauri/src/http_api) listens, checks every guard, routes a request to
// one of these calls with its arguments checked, and hands it to the window;
// the core runs it through the AI service, so the API sees and changes only
// what AI may (notebooks with Allow AI Access on), and writes like an outside
// edit: bodies as Yjs operations, metadata by HLC.
import type { AiNote, AiNoteUpdate, AiPatch, AiService } from './ai'
import { NOTE_STATUSES, type NoteStatus } from './storage'

export const HTTP_API_OPS = [
  'notebooks.list',
  'notebooks.create',
  'tags.list',
  'notes.search',
  'notes.create',
  'notes.read',
  'notes.update',
  'notes.trash',
] as const
export type HttpApiOp = (typeof HTTP_API_OPS)[number]

/** The calls a read-only token may not make; Rust refuses them first. */
export const HTTP_API_WRITES: readonly HttpApiOp[] = [
  'notebooks.create',
  'notes.create',
  'notes.update',
  'notes.trash',
]

export interface HttpApiCall {
  op: HttpApiOp
  /** The note a call is about (read, update, trash). */
  note: string | null
  args: Readonly<Record<string, unknown>>
}

export interface HttpApiRequest {
  id: number
  call: HttpApiCall
}

const isOp = (value: unknown): value is HttpApiOp =>
  typeof value === 'string' && (HTTP_API_OPS as readonly string[]).includes(value)

/** The event's payload as Rust sends it, or null for any other shape. */
export function readHttpApiRequest(payload: unknown): HttpApiRequest | null {
  if (typeof payload !== 'object' || payload === null) return null
  const { id, op, note, args } = payload as Record<string, unknown>
  if (!Number.isSafeInteger(id) || (id as number) < 0 || !isOp(op)) return null
  if (note !== null && typeof note !== 'string') return null
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null
  return { id: id as number, call: { op, note, args: args as Record<string, unknown> } }
}

const invalid = () => new Error('E_HTTP_API_ARGS_INVALID')

function text(args: HttpApiCall['args'], key: string): string {
  const value = args[key]
  if (typeof value !== 'string') throw invalid()
  return value
}

function optionalText(args: HttpApiCall['args'], key: string): string | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalid()
  return value
}

function noteId(call: HttpApiCall): string {
  if (call.note === null) throw invalid()
  return call.note
}

function patchesOf(value: unknown): AiPatch[] {
  if (!Array.isArray(value)) throw invalid()
  return value.map((patch: unknown) => {
    const { find, replace } = (patch ?? {}) as Record<string, unknown>
    if (typeof find !== 'string' || typeof replace !== 'string') throw invalid()
    return { find, replace }
  })
}

function tagsOf(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((name) => typeof name === 'string')) throw invalid()
  return value as string[]
}

function statusOf(value: unknown): NoteStatus {
  if (!(NOTE_STATUSES as readonly unknown[]).includes(value)) throw invalid()
  return value as NoteStatus
}

function updateOf(call: HttpApiCall): AiNoteUpdate {
  const { args } = call
  const title = optionalText(args, 'title')
  const markdown = optionalText(args, 'markdown')
  const notebook = optionalText(args, 'notebook')
  if (markdown !== undefined && args['patches'] !== undefined) {
    throw new Error('E_AI_BODY_CONFLICT')
  }
  return {
    id: noteId(call),
    ...(title === undefined ? {} : { title }),
    ...(markdown !== undefined
      ? { body: { markdown } }
      : args['patches'] !== undefined
        ? { body: { patches: patchesOf(args['patches']) } }
        : {}),
    ...(notebook === undefined ? {} : { notebook }),
    ...(args['tags'] === undefined ? {} : { tags: tagsOf(args['tags']) }),
    ...(args['status'] === undefined ? {} : { status: statusOf(args['status']) }),
  }
}

const iso = (ms: number) => new Date(ms).toISOString()

const noteJson = (note: AiNote) => ({
  ...note,
  createdAt: iso(note.createdAt),
  updatedAt: iso(note.updatedAt),
})

/** The JSON a call answers with; a failure throws its code (E_NOTE_NOT_FOUND for anything AI may not see). */
export async function runHttpApiCall(ai: AiService, call: HttpApiCall): Promise<unknown> {
  const { args } = call
  switch (call.op) {
    case 'notebooks.list':
      return { notebooks: await ai.notebooks() }
    case 'notebooks.create': {
      const parent = optionalText(args, 'parent')
      return ai.createNotebook(
        parent === undefined ? { name: text(args, 'name') } : { name: text(args, 'name'), parent },
      )
    }
    case 'tags.list':
      return { tags: await ai.tags() }
    case 'notes.search': {
      const limit = args['limit']
      if (limit !== undefined && !Number.isSafeInteger(limit)) throw invalid()
      const hits = await ai.search(text(args, 'query'), limit as number | undefined)
      return { results: hits.map((hit) => ({ ...hit, updatedAt: iso(hit.updatedAt) })) }
    }
    case 'notes.create':
      return ai.create({
        title: text(args, 'title'),
        markdown: text(args, 'markdown'),
        notebook: text(args, 'notebook'),
      })
    case 'notes.read':
      return noteJson(await ai.read(noteId(call)))
    case 'notes.update':
      return noteJson(await ai.update(updateOf(call)))
    case 'notes.trash':
      return { ...(await ai.trash(noteId(call))), trashed: true }
  }
}
