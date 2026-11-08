// The bridge's envelope as the page sees it (docs/specs/iphone-screens.md, Message envelope).
// Rust checks every message before it comes and after it leaves; the page checks only the
// envelope, so a request from another version of the app is dropped rather than misread.

import type { NoteStatus } from '../../../../core/storage'
import type { HapticKind } from '../haptics'
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
  'settings.notebooks',
  'editor.show',
  'editor.prepare',
  'editor.hide',
  'editor.setMode',
  'glass.get',
  'glass.set',
  'editor.focus',
  'notes.batch',
  'trash.empty',
  'book.create',
  'template.create',
  'template.apply',
  'note.text',
  'note.complete',
  'note.undoStatus',
  'editor.format',
  'editor.ai',
  'editor.find',
  'editor.insets',
  'editor.duplicate',
  'note.info',
  'note.setDates',
  'note.applyFrontMatter',
  'note.addTag',
  'note.today',
  'activity.writing',
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

/** A chip under the note's title, whose picker Swift draws. */
export type EditorPicker = 'notebook' | 'status' | 'tags'

/** What the native More menu, pickers and Note Info show of the note. */
export interface EditorNoteFacts {
  readonly id: string
  readonly bookId: string | null
  readonly status: NoteStatus
  readonly pinned: boolean
  readonly tagIds: readonly string[]
  readonly createdAt: number
  readonly updatedAt: number
}

export type ScreensNotice =
  | ({ readonly notice: 'tabs.state' } & TabsState)
  | ({ readonly notice: 'settings.open' } & SettingsOpen)
  | { readonly notice: 'nav.openNote'; readonly noteId: string; readonly title: string }
  | { readonly notice: 'nav.back' }
  | { readonly notice: 'editor.ready'; readonly noteId: string }
  | { readonly notice: 'editor.mode'; readonly noteId: string; readonly mode: EditorMode }
  | { readonly notice: 'editor.title'; readonly id: string; readonly title: string }
  | { readonly notice: 'editor.scroll'; readonly titleVisible: boolean }
  | ({ readonly notice: 'editor.note' } & EditorNoteFacts)
  | { readonly notice: 'editor.picker'; readonly noteId: string; readonly picker: EditorPicker }
  | { readonly notice: 'editor.haptic'; readonly kind: HapticKind }
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
