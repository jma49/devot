import type { EditorMode } from './message'
import type { ScreensHandlers } from './ops'

/** What the native editor screen asks of the page's editor (docs/specs/iphone-screens.md). */
export interface NativeEditor {
  readonly show: (noteId: string) => void
  /** Resolves once the page has painted without the editor. */
  readonly hide: () => Promise<void>
  readonly setMode: (mode: EditorMode) => void
  readonly info: () => void
}

const invalid = () => new Error('E_SCREENS_ARGS_INVALID')

const isMode = (value: unknown): value is EditorMode => value === 'edit' || value === 'preview'

export function editorHandlers(editor: () => NativeEditor | null): ScreensHandlers {
  return {
    'editor.show': async (args) => {
      const noteId = args['noteId']
      if (typeof noteId !== 'string' || noteId === '') throw invalid()
      editor()?.show(noteId)
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
  }
}
