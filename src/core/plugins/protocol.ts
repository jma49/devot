// The message protocol between Devot and a plugin's frame (ADR 0005), version 1. Every message a plugin sends is read here
// before the host acts on it: its shape, a known method, the permission behind it and its sizes.
import { MAX_BODY_BYTES, MAX_TITLE_CHARS } from '../noteLimits'
import { utf8Length, wellFormed } from '../text'
import { isRecord } from '../isRecord'
import type { PluginPermission } from './manifest'

export const PLUGIN_PROTOCOL_VERSION = 1

/** Methods a plugin calls on the host. */
const PLUGIN_METHODS = [
  'note.read',
  'note.replace',
  'note.selection',
  'note.insert',
  'ui.show',
  'ui.hide',
  'storage.get',
  'storage.set',
  'storage.delete',
  'storage.keys',
  'settings.get',
  'notes.list',
  'notes.search',
  'notes.get',
  'notebooks.list',
] as const
export type PluginMethod = (typeof PLUGIN_METHODS)[number]

/** Methods the host calls on a plugin. */
export type HostMethod =
  | 'command.run'
  | 'preview.render'
  | 'preview.edit'
  | 'import.convert'
  | 'export.convert'

const METHOD_PERMISSION: Readonly<Record<PluginMethod, PluginPermission | null>> = {
  'note.read': 'note.read',
  'note.replace': 'note.edit',
  'note.selection': 'note.read',
  'note.insert': 'note.edit',
  'ui.show': null,
  'ui.hide': null,
  'storage.get': 'storage',
  'storage.set': 'storage',
  'storage.delete': 'storage',
  'storage.keys': 'storage',
  'settings.get': null,
  'notes.list': 'notes.read',
  'notes.search': 'notes.read',
  'notes.get': 'notes.read',
  'notebooks.list': 'notes.read',
}

/** The note methods, and showing a panel, work only while a command of the plugin runs or its panel is open. */
const NEEDS_ACTIVE: ReadonlySet<PluginMethod> = new Set([
  'note.read',
  'note.replace',
  'note.selection',
  'note.insert',
  'ui.show',
])

const UI_HEIGHT = { min: 80, max: 640, default: 320 } as const
/** A drawn block's Markdown, and a converted file's text. */
export const MAX_RENDER_CHARS = 256 * 1024
const MAX_EXPORT_CHARS = 20 * 1024 * 1024
/** A stored value as JSON; Rust also caps a plugin's whole store (`plugins/storage.rs`). */
export const MAX_STORAGE_VALUE_BYTES = 256 * 1024
/** Notes one `notes.list` or `notes.search` answers at most, and when the plugin names no limit. */
export const NOTES_LIMIT = { max: 500, search: 100, default: 50 } as const
const MAX_QUERY_CHARS = 200
const NOTE_ID = /^[A-Za-z0-9-]{1,64}$/
const STORAGE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
const MAX_JSON_DEPTH = 32
/** Calls a plugin may have waiting on the host at once. */
export const MAX_PENDING_CALLS = 64
export const HOST_CALL_TIMEOUT_MS: Readonly<Record<HostMethod, number>> = {
  'command.run': 60_000,
  'preview.render': 5_000,
  // The user edits the block in the plugin's panel for as long as they like.
  'preview.edit': 60 * 60_000,
  'import.convert': 30_000,
  'export.convert': 30_000,
}

export type PluginCall =
  | { method: 'note.read' }
  | { method: 'note.replace'; base: string; markdown: string }
  | { method: 'note.selection' }
  | { method: 'note.insert'; text: string; selected: string | null }
  | { method: 'ui.show'; height: number }
  | { method: 'ui.hide' }
  | { method: 'storage.get'; key: string }
  | { method: 'storage.set'; key: string; value: JsonValue }
  | { method: 'storage.delete'; key: string }
  | { method: 'storage.keys' }
  | { method: 'settings.get' }
  | { method: 'notes.list'; limit: number }
  | { method: 'notes.search'; query: string; limit: number }
  | { method: 'notes.get'; id: string }
  | { method: 'notebooks.list' }

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface CallMessage {
  devot: typeof PLUGIN_PROTOCOL_VERSION
  kind: 'call'
  seq: number
  method: string
  params?: unknown
}

export type ResultMessage =
  | { devot: typeof PLUGIN_PROTOCOL_VERSION; kind: 'result'; seq: number; ok: true; value: unknown }
  | { devot: typeof PLUGIN_PROTOCOL_VERSION; kind: 'result'; seq: number; ok: false; code: string }

export type PluginEvent =
  | { name: 'ui.hidden' }
  | { name: 'settings.changed' }
  | { name: 'note.opened'; value: { id: string | null } }

export type EventMessage = { devot: typeof PLUGIN_PROTOCOL_VERSION; kind: 'event' } & PluginEvent

export type IncomingMessage = CallMessage | ResultMessage

const isSeq = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const CODE = /^E_[A-Z0-9_]{1,62}$/

/** A message from a plugin, or null for anything that is not one (left unanswered). */
export function readMessage(raw: unknown): IncomingMessage | null {
  if (!isRecord(raw) || raw['devot'] !== PLUGIN_PROTOCOL_VERSION || !isSeq(raw['seq'])) return null
  if (raw['kind'] === 'call' && typeof raw['method'] === 'string') {
    return {
      devot: PLUGIN_PROTOCOL_VERSION,
      kind: 'call',
      seq: raw['seq'],
      method: raw['method'],
      params: raw['params'],
    }
  }
  if (raw['kind'] === 'result' && raw['ok'] === true) {
    return {
      devot: PLUGIN_PROTOCOL_VERSION,
      kind: 'result',
      seq: raw['seq'],
      ok: true,
      value: raw['value'],
    }
  }
  if (raw['kind'] === 'result' && raw['ok'] === false) {
    const code = typeof raw['code'] === 'string' && CODE.test(raw['code']) ? raw['code'] : null
    return {
      devot: PLUGIN_PROTOCOL_VERSION,
      kind: 'result',
      seq: raw['seq'],
      ok: false,
      code: code ?? 'E_PLUGIN_FAILED',
    }
  }
  return null
}

export interface CallContext {
  granted: ReadonlySet<PluginPermission>
  /** One of the plugin's commands is running or its panel is open. */
  active: boolean
}

export type CheckedCall = { ok: true; call: PluginCall } | { ok: false; code: string }

const isMethod = (method: string): method is PluginMethod =>
  (PLUGIN_METHODS as readonly string[]).includes(method)

/** Plain JSON only: no other object kinds, no non-finite numbers, no lone surrogates. */
function isJson(value: unknown, depth = 0): value is JsonValue {
  if (depth > MAX_JSON_DEPTH) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return wellFormed(value) === value
  if (Array.isArray(value)) return value.every((item) => isJson(item, depth + 1))
  if (!isRecord(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return false
  return Object.entries(value).every(
    ([key, item]) => wellFormed(key) === key && isJson(item, depth + 1),
  )
}

function limit(p: Record<string, unknown>, max: number): number | null {
  const value = p['limit'] ?? NOTES_LIMIT.default
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? Math.min(value, max)
    : null
}

const storageKey = (p: Record<string, unknown>): string | null => {
  const key = p['key']
  return typeof key === 'string' && STORAGE_KEY.test(key) ? key : null
}

function params(call: CallMessage, method: PluginMethod): PluginCall | null {
  const p = call.params ?? {}
  if (!isRecord(p)) return null
  switch (method) {
    case 'note.read':
    case 'note.selection':
    case 'ui.hide':
    case 'storage.keys':
    case 'settings.get':
    case 'notebooks.list':
      return Object.keys(p).length === 0 ? { method } : null
    case 'notes.list': {
      const n = limit(p, NOTES_LIMIT.max)
      return n === null ? null : { method, limit: n }
    }
    case 'notes.search': {
      const n = limit(p, NOTES_LIMIT.search)
      const query = p['query']
      if (n === null || typeof query !== 'string' || wellFormed(query) !== query) return null
      if (query.trim() === '' || [...query].length > MAX_QUERY_CHARS) return null
      return { method, query, limit: n }
    }
    case 'notes.get': {
      const id = p['id']
      return typeof id === 'string' && NOTE_ID.test(id) ? { method, id } : null
    }
    case 'storage.get':
    case 'storage.delete': {
      const key = storageKey(p)
      return key !== null && Object.keys(p).length === 1 ? { method, key } : null
    }
    case 'storage.set': {
      const key = storageKey(p)
      const value = p['value']
      if (key === null || !isJson(value)) return null
      if (utf8Length(JSON.stringify(value)) > MAX_STORAGE_VALUE_BYTES) return null
      return { method, key, value }
    }
    case 'note.replace': {
      const { base, markdown } = p
      if (typeof base !== 'string' || typeof markdown !== 'string') return null
      if (wellFormed(base) !== base || wellFormed(markdown) !== markdown) return null
      if (utf8Length(markdown) > MAX_BODY_BYTES || utf8Length(base) > MAX_BODY_BYTES) return null
      return { method, base, markdown }
    }
    case 'note.insert': {
      const { text, selected = null } = p
      if (typeof text !== 'string' || wellFormed(text) !== text) return null
      if (
        selected !== null &&
        (typeof selected !== 'string' || wellFormed(selected) !== selected)
      ) {
        return null
      }
      if (utf8Length(text) > MAX_BODY_BYTES) return null
      if (selected !== null && utf8Length(selected) > MAX_BODY_BYTES) return null
      return { method, text, selected }
    }
    case 'ui.show': {
      const height = p['height'] ?? UI_HEIGHT.default
      if (typeof height !== 'number' || !Number.isInteger(height)) return null
      return { method, height: Math.min(UI_HEIGHT.max, Math.max(UI_HEIGHT.min, height)) }
    }
  }
}

/** Whether the host may act on a call: a known method, its permission granted, its parameters well formed. */
export function checkCall(call: CallMessage, context: CallContext): CheckedCall {
  if (!isMethod(call.method)) return { ok: false, code: 'E_PLUGIN_METHOD_UNKNOWN' }
  const permission = METHOD_PERMISSION[call.method]
  if (permission !== null && !context.granted.has(permission)) {
    return { ok: false, code: 'E_PLUGIN_PERMISSION_DENIED' }
  }
  if (NEEDS_ACTIVE.has(call.method) && !context.active) {
    return { ok: false, code: 'E_PLUGIN_NOT_ACTIVE' }
  }
  const checked = params(call, call.method)
  return checked ? { ok: true, call: checked } : { ok: false, code: 'E_PLUGIN_MESSAGE_INVALID' }
}

export interface Converted {
  title: string
  markdown?: string
  html?: string
  tags?: string[]
  createdAt?: number
  updatedAt?: number
  attachments?: { name: string; mime: string; data: string }[]
  diagnostics?: string[]
}

/** A plugin's answer to a host call, checked; throws E_PLUGIN_RESULT_INVALID. */
export function checkResult(method: 'command.run', value: unknown): null
export function checkResult(method: 'preview.render', value: unknown): string | null
export function checkResult(method: 'preview.edit', value: unknown): string | null
export function checkResult(method: 'import.convert', value: unknown): Converted
export function checkResult(
  method: 'import.convert',
  value: unknown,
  apiVersion: number,
): Converted | Converted[]
export function checkResult(method: 'export.convert', value: unknown): string
export function checkResult(method: HostMethod, value: unknown, apiVersion = 2): unknown {
  const invalid = () => {
    throw new Error('E_PLUGIN_RESULT_INVALID')
  }
  switch (method) {
    case 'command.run':
      return null
    case 'preview.render':
      if (value === null || value === undefined) return null
      return typeof value === 'string' && value.length <= MAX_RENDER_CHARS ? value : invalid()
    case 'preview.edit':
      if (value === null || value === undefined) return null
      return typeof value === 'string' &&
        wellFormed(value) === value &&
        utf8Length(value) <= MAX_BODY_BYTES
        ? value
        : invalid()
    case 'import.convert': {
      if (Array.isArray(value) && (apiVersion < 3 || value.length > 5000)) return invalid()
      let bytes = 0
      const convert = (raw: unknown): Converted => {
        if (!isRecord(raw)) return invalid()
        const { title, markdown, html, tags, createdAt, updatedAt, attachments, diagnostics } = raw
        const text = markdown ?? html
        if (
          typeof title !== 'string' ||
          typeof text !== 'string' ||
          (markdown !== undefined && html !== undefined)
        )
          return invalid()
        if (
          wellFormed(title) !== title ||
          wellFormed(text) !== text ||
          [...title].length > MAX_TITLE_CHARS ||
          utf8Length(text) > MAX_BODY_BYTES
        )
          return invalid()
        if (
          apiVersion < 3 &&
          [html, tags, createdAt, updatedAt, attachments, diagnostics].some((v) => v !== undefined)
        )
          return invalid()
        const out: Converted = {
          title: title.replace(/[\r\n]+/g, ' ').trim(),
          ...(markdown === undefined ? { html: text } : { markdown: text }),
        }
        if (tags !== undefined) {
          if (
            !Array.isArray(tags) ||
            tags.length > 1000 ||
            !tags.every(
              (tag) =>
                typeof tag === 'string' &&
                wellFormed(tag) === tag &&
                tag.trim().length > 0 &&
                [...tag].length <= 100 &&
                !/[\r\n]/.test(tag),
            )
          )
            return invalid()
          out.tags = tags
        }
        for (const [key, at] of [
          ['createdAt', createdAt],
          ['updatedAt', updatedAt],
        ] as const) {
          if (at !== undefined) {
            if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) return invalid()
            out[key] = at
          }
        }
        bytes += utf8Length(text)
        if (attachments !== undefined) {
          if (!Array.isArray(attachments) || attachments.length > 1000) return invalid()
          out.attachments = attachments.map((a) => {
            if (!isRecord(a)) return invalid()
            const { name, mime, data } = a
            if (
              typeof name !== 'string' ||
              !name ||
              [...name].length > 200 ||
              wellFormed(name) !== name ||
              /\p{Cc}/u.test(name) ||
              typeof mime !== 'string' ||
              !/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(mime) ||
              mime.length > 100 ||
              typeof data !== 'string' ||
              data.length > 140 * 1024 * 1024 ||
              data.length % 4 !== 0 ||
              /[^A-Za-z0-9+/]/.test(data.replace(/={1,2}$/, ''))
            )
              return invalid()
            bytes += data.length
            return { name, mime, data }
          })
        }
        if (diagnostics !== undefined) {
          if (
            !Array.isArray(diagnostics) ||
            diagnostics.length > 1000 ||
            !diagnostics.every(
              (code) => typeof code === 'string' && /^[EWI]_[A-Z0-9_]{1,62}$/.test(code),
            )
          )
            return invalid()
          out.diagnostics = diagnostics
        }
        if (bytes > 140 * 1024 * 1024) return invalid()
        return out
      }
      return Array.isArray(value) ? value.map(convert) : convert(value)
    }
    case 'export.convert':
      return typeof value === 'string' && value.length <= MAX_EXPORT_CHARS ? value : invalid()
  }
}
