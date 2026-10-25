// Where the window was when it closed: the library view and its filter, the
// workspace, the open note with its selection and scroll positions, the view
// mode and the library views shown as a board, so a restart opens where the user left off. Like focus mode and
// the hidden sidebar it is a view preference of one window: it lives in the
// webview's local storage under the window's label, never in the note
// database, and never syncs. Everything read back is checked; a part that does not check
// out falls back on its own, and anything gone since (a notebook, a tag, the
// note) is skipped quietly when restoring (`restorePlan`).
import { UUID_V7 } from '../../core/ids'
import { NOTE_STATUSES, type NoteStatus } from '../../core/storage'
import type { NoteFilter } from '../../core/tags'
import { current } from './focus'
import type { Mode } from './ModeControl'

export type LibraryView = { kind: 'all' } | { kind: 'book'; id: string } | { kind: 'templates' }

export interface SelectionState {
  anchor: number
  head: number
}

/**
 * The editor's scroll position: the line at the top of the editor (the
 * position it starts at) and how far it is scrolled past that line's top.
 * Kept by text position rather than pixels, so it finds the same line when
 * line heights change (another window width, font or size).
 */
export interface EditorTop {
  pos: number
  offset: number
}

export interface NoteState {
  id: string
  selection?: SelectionState
  editorTop?: EditorTop
  previewTop?: number
  /** Whether the editor had the keyboard; it takes it again when restored. */
  keyboard: boolean
}

export interface LastState {
  view: LibraryView
  filter: NoteFilter | null
  mode: Mode
  note?: NoteState
  workspace?: string
  /** The library views shown as a board (list view keys, see `isBoardView`), the one switched last at the end. */
  boards?: readonly string[]
}

/** The stored format; another one (a later Devot) is not read. */
const VERSION = 1
const MODES: readonly string[] = ['edit', 'split', 'preview'] satisfies Mode[]

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isId = (value: unknown): value is string => typeof value === 'string' && UUID_V7.test(value)
const isPosition = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const isOffset = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

function readView(value: unknown): LibraryView {
  if (!isObject(value)) return { kind: 'all' }
  if (value['kind'] === 'templates') return { kind: 'templates' }
  if (value['kind'] === 'book' && isId(value['id'])) return { kind: 'book', id: value['id'] }
  return { kind: 'all' }
}

function readFilter(value: unknown): NoteFilter | null {
  if (!isObject(value)) return null
  const kind = value['kind']
  if (kind === 'pinned') return { kind }
  const status = value['status']
  if (kind === 'status' && NOTE_STATUSES.some((s) => s === status)) {
    return { kind, status: status as NoteStatus }
  }
  if (kind === 'tag' && isId(value['tagId'])) return { kind, tagId: value['tagId'] }
  return null
}

function readNote(value: unknown): NoteState | undefined {
  if (!isObject(value) || !isId(value['id'])) return undefined
  const note: NoteState = { id: value['id'], keyboard: value['keyboard'] === true }
  const selection = value['selection']
  if (isObject(selection) && isPosition(selection['anchor']) && isPosition(selection['head'])) {
    note.selection = { anchor: selection['anchor'], head: selection['head'] }
  }
  const top = value['editorTop']
  if (isObject(top) && isPosition(top['pos']) && isOffset(top['offset'])) {
    note.editorTop = { pos: top['pos'], offset: top['offset'] }
  }
  const previewTop = value['previewTop']
  if (isOffset(previewTop) && previewTop >= 0) note.previewTop = previewTop
  return note
}

export type ListLayout = 'list' | 'board'

// A status view is one column already, and an agent's view is not kept (App.tsx), so neither has a board.
const BOARD_FILTERS = /^(all|filter:pinned|filter:tag:(?<tag>[^|]*))$/
const BOARDS_KEPT = 100

/**
 * Whether `view` is the key of a library view that can show a board: All
 * Notes, a notebook (a workspace too), Pinned or a tag, each as the window
 * keys its list (`<filter>|<notebook ID or nothing>`). A status filter is
 * one column already; search results, Templates and the Trash have no board.
 */
export function isBoardView(view: string): boolean {
  const parts = view.split('|')
  if (parts.length !== 2) return false
  const [filter, book] = parts as [string, string]
  const match = BOARD_FILTERS.exec(filter)
  if (!match) return false
  const tag = match.groups?.['tag']
  return (tag === undefined || isId(tag)) && (book === '' || isId(book))
}

export function layoutOf(boards: readonly string[] | undefined, view: string): ListLayout {
  return boards?.includes(view) ? 'board' : 'list'
}

/** `boards` with `view` shown as `layout`; only the views switched last are kept. */
export function withLayout(
  boards: readonly string[] | undefined,
  view: string,
  layout: ListLayout,
): readonly string[] {
  if (!isBoardView(view)) return boards ?? []
  const others = (boards ?? []).filter((v) => v !== view)
  return layout === 'board' ? [...others, view].slice(-BOARDS_KEPT) : others
}

function readBoards(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const views = value.filter((v): v is string => typeof v === 'string' && isBoardView(v))
  return [...new Set(views)].slice(-BOARDS_KEPT)
}

export function parseLastState(raw: string | null): LastState | undefined {
  if (!raw) return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isObject(value) || value['v'] !== VERSION) return undefined
  const mode = value['mode']
  const state: LastState = {
    view: readView(value['view']),
    filter: readFilter(value['filter']),
    mode: typeof mode === 'string' && MODES.includes(mode) ? (mode as Mode) : 'edit',
  }
  const note = readNote(value['note'])
  if (note) state.note = note
  if (isId(value['workspace'])) state.workspace = value['workspace']
  const boards = readBoards(value['boards'])
  if (boards) state.boards = boards
  return state
}

export function serializeLastState(state: LastState): string {
  return JSON.stringify({ v: VERSION, ...state })
}

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>

/** Reads and writes one window's last state; storage failures mean "none". */
export function lastStateStore(storage: KeyValue | undefined, label: string) {
  const key = `devot.lastState.${label}`
  return {
    load(): LastState | undefined {
      try {
        return parseLastState(storage?.getItem(key) ?? null)
      } catch {
        return undefined
      }
    },
    save(state: LastState) {
      try {
        storage?.setItem(key, serializeLastState(state))
      } catch {
        console.warn('W_LAST_STATE_SAVE_FAILED')
      }
    },
  }
}

export const currentLastStateStore = () => current(lastStateStore)

export interface LiveLibrary {
  books: ReadonlySet<string>
  tags: ReadonlySet<string>
  notes: ReadonlySet<string>
}

/**
 * What to show for a stored state: a notebook that is gone shows All Notes,
 * a filter on a tag that is gone shows no filter, and a note that is gone
 * (deleted, in the Trash or purged) leaves the view with no note open. A
 * workspace opens again only while its notebook exists and a notebook shows.
 */
export function restorePlan(
  state: LastState,
  live: LiveLibrary,
): { view: LibraryView; filter: NoteFilter | null; note?: NoteState; workspace?: string } {
  const view: LibraryView =
    state.view.kind === 'book' && !live.books.has(state.view.id) ? { kind: 'all' } : state.view
  const filter =
    view.kind === 'templates' ||
    (state.filter?.kind === 'tag' && !live.tags.has(state.filter.tagId))
      ? null
      : state.filter
  const note = state.note && live.notes.has(state.note.id) ? state.note : undefined
  const workspace =
    state.workspace !== undefined && live.books.has(state.workspace) && view.kind === 'book'
      ? state.workspace
      : undefined
  return { view, filter, ...(note ? { note } : {}), ...(workspace ? { workspace } : {}) }
}

export function clampSelection(selection: SelectionState, length: number): SelectionState {
  return {
    anchor: Math.min(selection.anchor, length),
    head: Math.min(selection.head, length),
  }
}

export function clampTop(top: EditorTop, length: number): EditorTop {
  return { pos: Math.min(top.pos, length), offset: top.offset }
}
