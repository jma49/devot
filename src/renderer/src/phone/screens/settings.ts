import type { NotebookChoice } from '../../notebookChoices'
import type { ScreensHandlers } from './ops'

export interface NativeSettings {
  /** Default Notebook's choices, in Library order: names only, never a note. */
  readonly notebooks: () => readonly NotebookChoice[]
}

export function settingsHandlers(settings: NativeSettings): ScreensHandlers {
  return {
    'settings.notebooks': async () => ({ notebooks: settings.notebooks() }),
  }
}
