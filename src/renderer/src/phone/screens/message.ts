// The bridge's envelope as the page sees it (docs/specs/iphone-screens.md, Message envelope).
// Rust checks every message before it comes and after it leaves; the page checks only the
// envelope, so a request from another version of the app is dropped rather than misread.

import type { PhoneTab } from '../navigation'

export const SCREENS_VERSION = 1

export const SCREENS_OPS = [
  'ping',
  'excerpts',
  'search',
  'note.create',
  'note.discard',
  'tabs.show',
  'tabs.popToRoot',
  'settings.showPane',
  'settings.notebooks',
  'editor.show',
  'editor.hide',
  'editor.setMode',
  'editor.info',
  'editor.focus',
  'notes.batch',
  'trash.empty',
  'template.create',
  'template.apply',
  'note.text',
] as const
export type ScreensOp = (typeof SCREENS_OPS)[number]

/** What the page shows under the native tab bar, and whether the bar should be up over it. */
export interface TabsState {
  readonly tab: PhoneTab
  readonly barHidden: boolean
  readonly attention: boolean
}

/** A Settings page one of the page's sheets opens in the native Settings. */
export interface SettingsOpen {
  readonly pane: 'licence'
  readonly focusKey: boolean
}

export type EditorMode = 'edit' | 'preview'

export type ScreensNotice =
  | ({ readonly notice: 'tabs.state' } & TabsState)
  | ({ readonly notice: 'settings.open' } & SettingsOpen)
  | { readonly notice: 'nav.openNote'; readonly noteId: string; readonly title: string }
  | { readonly notice: 'nav.back' }
  | { readonly notice: 'editor.ready'; readonly noteId: string }
  | { readonly notice: 'editor.mode'; readonly noteId: string; readonly mode: EditorMode }
  | { readonly notice: 'editor.title'; readonly id: string; readonly title: string }
  | { readonly notice: 'editor.scroll'; readonly titleVisible: boolean }
  | { readonly notice: 'note.new'; readonly bookId?: string }
  | {
      readonly notice: 'notes.changed'
      readonly rev: number
      readonly ids: readonly string[]
      readonly all?: true
    }
  | { readonly notice: 'books.changed' | 'tags.changed' | 'savedSearches.changed' }

export interface ScreensRequest {
  readonly id: number
  readonly op: ScreensOp
  readonly args: Readonly<Record<string, unknown>>
}

export type ScreensReply =
  | { readonly v: 1; readonly id: number; readonly ok: true; readonly result: unknown }
  | { readonly v: 1; readonly id: number; readonly ok: false; readonly code: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isOp = (op: unknown): op is ScreensOp => SCREENS_OPS.some((known) => known === op)

const REQUEST_KEYS = ['args', 'id', 'op', 'v'].join()

export function parseRequest(value: unknown): ScreensRequest | null {
  if (!isRecord(value) || Object.keys(value).sort().join() !== REQUEST_KEYS) return null
  const { v, id, op, args } = value
  if (v !== SCREENS_VERSION || typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) {
    return null
  }
  if (!isOp(op) || !isRecord(args)) return null
  return { id, op, args }
}

export const replied = (id: number, result: unknown): ScreensReply => ({
  v: SCREENS_VERSION,
  id,
  ok: true,
  result: result ?? null,
})

// Rust takes only an error or warning code in a reply, never text.
const REPLY_CODE = /^[EW]_[A-Z0-9_]{1,62}$/

export const refused = (id: number, code: string): ScreensReply => ({
  v: SCREENS_VERSION,
  id,
  ok: false,
  code: REPLY_CODE.test(code) ? code : 'E_SCREENS_OP_FAILED',
})

export const noticed = (notice: ScreensNotice) => ({ v: SCREENS_VERSION, ...notice })
