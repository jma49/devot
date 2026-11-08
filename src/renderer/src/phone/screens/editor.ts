import type { EditorMode } from './message'
import type { ScreensHandlers } from './ops'

/** What the native editor screen asks of the page's editor (docs/specs/iphone-screens.md). */
export interface NativeEditor {
  /** `focusBody`: a new note, whose body takes the caret once Swift asks (`focus`). */
  readonly show: (noteId: string, focusBody: boolean) => void
  /** Resolves once the page has painted without the editor. */
  readonly hide: () => Promise<void>
  readonly setMode: (mode: EditorMode) => void
  readonly info: () => void
  /** Whether the body of a note shown to be typed in took the caret; the keyboard is up by now. */
  readonly focus: () => Promise<boolean>
}

const invalid = () => new Error('E_SCREENS_ARGS_INVALID')

const isMode = (value: unknown): value is EditorMode => value === 'edit' || value === 'preview'

export function editorHandlers(editor: () => NativeEditor | null): ScreensHandlers {
  return {
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
    'editor.info': async () => {
      editor()?.info()
      return {}
    },
    'editor.focus': async () => ({ focused: (await editor()?.focus()) ?? false }),
  }
}
