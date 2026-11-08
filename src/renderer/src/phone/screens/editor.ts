import type { FindTarget } from '../../find/target'
import type { EditorMode } from './message'
import type { ScreensHandlers } from './ops'

/** The formatting bar's buttons, the editor's format IDs Rust lets through (`screens::message`). */
export const BAR_FORMATS = ['heading', 'bold', 'italic', 'taskList', 'code', 'link'] as const
export type BarFormat = (typeof BAR_FORMATS)[number]

export type FindAction = 'search' | 'next' | 'previous' | 'close'

/** What the native find bar shows: `current` counts from 1, 0 with no match. */
export interface FindCount {
  readonly total: number
  readonly current: number
  readonly capped: boolean
}

export const NO_FIND_COUNT: FindCount = { total: 0, current: 0, capped: false }

/** Runs the find bar's action on the editor's search, plain text in any case, and counts after it. */
export function runFind(target: FindTarget | null, action: FindAction, query: string): FindCount {
  if (!target) return NO_FIND_COUNT
  if (action === 'close') {
    target.clear()
    return NO_FIND_COUNT
  }
  if (action === 'search') target.search({ query, regexp: false, caseSensitive: false })
  else if (action === 'next') target.next()
  else target.previous()
  const { total, current, capped } = target.status()
  return { total, current: current === null ? 0 : current + 1, capped }
}

/** What the native editor screen asks of the page's editor (docs/specs/iphone-screens.md). */
export interface NativeEditor {
  /** `focusBody`: a new note, whose body takes the caret once Swift asks (`focus`). */
  readonly show: (noteId: string, focusBody: boolean) => void
  /** Resolves once the page has painted without the editor. */
  readonly hide: () => Promise<void>
  readonly setMode: (mode: EditorMode) => void
  /** Whether the body of a note shown to be typed in took the caret; the keyboard is up by now. */
  readonly focus: () => Promise<boolean>
  readonly format: (id: BarFormat) => void
  readonly ai: (action: 'suggest' | 'accept') => void
  readonly find: (action: FindAction, query: string) => FindCount
  /** The keyboard and the formatting bar cover `bottom` points of the note, already. */
  readonly insets: (bottom: number) => void
  /** The shown note's copy, which Swift then opens; null when no note is shown. */
  readonly duplicate: () => Promise<{ id: string; title: string } | null>
}

const invalid = () => new Error('E_SCREENS_ARGS_INVALID')

const isMode = (value: unknown): value is EditorMode => value === 'edit' || value === 'preview'
const isFormat = (value: unknown): value is BarFormat =>
  BAR_FORMATS.some((known) => known === value)
const FIND_ACTIONS: readonly FindAction[] = ['search', 'next', 'previous', 'close']
const isFindAction = (value: unknown): value is FindAction =>
  FIND_ACTIONS.some((known) => known === value)

/** `prepare`: a native row was pressed, so its note is opened ahead of the push (`prepared.ts`). */
export function editorHandlers(
  editor: () => NativeEditor | null,
  notes: { readonly prepare: (noteId: string) => void },
): ScreensHandlers {
  return {
    'editor.prepare': async (args) => {
      const noteId = args['noteId']
      if (typeof noteId !== 'string' || noteId === '') throw invalid()
      notes.prepare(noteId)
      return {}
    },
    'editor.show': async (args) => {
      const noteId = args['noteId']
      const focus = args['focus']
      if (typeof noteId !== 'string' || noteId === '') throw invalid()
      if (focus !== undefined && focus !== 'body') throw invalid()
      editor()?.show(noteId, focus === 'body')
      return {}
    },
    'editor.hide': async () => {
      await editor()?.hide()
      return {}
    },
    'editor.setMode': async (args) => {
      const mode = args['mode']
      if (!isMode(mode)) throw invalid()
      editor()?.setMode(mode)
      return {}
    },
    'editor.focus': async () => ({ focused: (await editor()?.focus()) ?? false }),
    'editor.format': async (args) => {
      const id = args['id']
      if (!isFormat(id)) throw invalid()
      editor()?.format(id)
      return {}
    },
    'editor.ai': async (args) => {
      const action = args['action']
      if (action !== 'suggest' && action !== 'accept') throw invalid()
      editor()?.ai(action)
      return {}
    },
    'editor.find': async (args) => {
      const action = args['action']
      const query = args['query']
      if (!isFindAction(action)) throw invalid()
      if ((action === 'search') !== (typeof query === 'string')) throw invalid()
      return editor()?.find(action, typeof query === 'string' ? query : '') ?? NO_FIND_COUNT
    },
    'editor.insets': async (args) => {
      const bottom = args['bottom']
      if (typeof bottom !== 'number' || !Number.isFinite(bottom) || bottom < 0) throw invalid()
      editor()?.insets(bottom)
      return {}
    },
    'editor.duplicate': async () => {
      const made = await editor()?.duplicate()
      if (!made) throw new Error('E_SCREENS_NO_NOTE')
      return made
    },
  }
}
