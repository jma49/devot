// The message protocol between Devot and a plugin's frame (ADR 0005), version 1. Every message a plugin sends is read here
// before the host acts on it: its shape, a known method, the permission behind it and its sizes.
import { MAX_BODY_BYTES, MAX_TITLE_CHARS } from '../noteLimits'
import { wellFormed } from '../text'
import type { PluginPermission } from './manifest'

export const PLUGIN_PROTOCOL_VERSION = 1

/** Methods a plugin calls on the host. */
export const PLUGIN_METHODS = ['note.read', 'note.replace', 'ui.show', 'ui.hide'] as const
export type PluginMethod = (typeof PLUGIN_METHODS)[number]

/** Methods the host calls on a plugin. */
export type HostMethod = 'command.run' | 'preview.render' | 'import.convert' | 'export.convert'

export const METHOD_PERMISSION: Readonly<Record<PluginMethod, PluginPermission | null>> = {
  'note.read': 'note.read',
  'note.replace': 'note.edit',
  'ui.show': null,
  'ui.hide': null,
}

/** The note methods, and showing a panel, work only while a command of the plugin runs or its panel is open. */
const NEEDS_ACTIVE: ReadonlySet<PluginMethod> = new Set(['note.read', 'note.replace', 'ui.show'])

export const UI_HEIGHT = { min: 80, max: 640, default: 320 } as const
/** A drawn block's Markdown, and a converted file's text. */
export const MAX_RENDER_CHARS = 256 * 1024
export const MAX_EXPORT_CHARS = 20 * 1024 * 1024
/** Calls a plugin may have waiting on the host at once. */
export const MAX_PENDING_CALLS = 64
export const HOST_CALL_TIMEOUT_MS: Readonly<Record<HostMethod, number>> = {
  'command.run': 60_000,
  'preview.render': 5_000,
  'import.convert': 30_000,
  'export.convert': 30_000,
}

export type PluginCall =
  | { method: 'note.read' }
  | { method: 'note.replace'; base: string; markdown: string }
  | { method: 'ui.show'; height: number }
  | { method: 'ui.hide' }

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

export interface EventMessage {
  devot: typeof PLUGIN_PROTOCOL_VERSION
  kind: 'event'
  name: 'ui.hidden'
}

export type IncomingMessage = CallMessage | ResultMessage

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isSeq = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const CODE = /^E_[A-Z0-9_]{1,62}$/

const utf8Length = (text: string) => new TextEncoder().encode(text).length

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

function params(call: CallMessage, method: PluginMethod): PluginCall | null {
  const p = call.params ?? {}
  if (!isRecord(p)) return null
  switch (method) {
    case 'note.read':
    case 'ui.hide':
      return Object.keys(p).length === 0 ? { method } : null
    case 'note.replace': {
      const { base, markdown } = p
      if (typeof base !== 'string' || typeof markdown !== 'string') return null
      if (wellFormed(base) !== base || wellFormed(markdown) !== markdown) return null
      if (utf8Length(markdown) > MAX_BODY_BYTES || utf8Length(base) > MAX_BODY_BYTES) return null
      return { method, base, markdown }
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
  markdown: string
}

/** A plugin's answer to a host call, checked; throws E_PLUGIN_RESULT_INVALID. */
export function checkResult(method: 'command.run', value: unknown): null
export function checkResult(method: 'preview.render', value: unknown): string | null
export function checkResult(method: 'import.convert', value: unknown): Converted
export function checkResult(method: 'export.convert', value: unknown): string
export function checkResult(method: HostMethod, value: unknown): unknown {
  const invalid = () => {
    throw new Error('E_PLUGIN_RESULT_INVALID')
  }
  switch (method) {
    case 'command.run':
      return null
    case 'preview.render':
      if (value === null || value === undefined) return null
      return typeof value === 'string' && value.length <= MAX_RENDER_CHARS ? value : invalid()
    case 'import.convert': {
      if (!isRecord(value)) return invalid()
      const { title, markdown } = value
      if (typeof title !== 'string' || typeof markdown !== 'string') return invalid()
      if (wellFormed(title) !== title || wellFormed(markdown) !== markdown) return invalid()
      if ([...title].length > MAX_TITLE_CHARS || utf8Length(markdown) > MAX_BODY_BYTES) {
        return invalid()
      }
      return { title: title.replace(/[\r\n]+/g, ' ').trim(), markdown }
    }
    case 'export.convert':
      return typeof value === 'string' && value.length <= MAX_EXPORT_CHARS ? value : invalid()
  }
}
