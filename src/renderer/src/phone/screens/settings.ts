import type { NotebookChoice } from '../../notebookChoices'
import type { ScreensHandlers } from './ops'

/** The Settings panes the page still draws under the native Settings, until each is native. */
export const WEB_PANES = ['appearance', 'sync'] as const
export type WebPane = (typeof WEB_PANES)[number]

export interface NativeSettings {
  readonly showPane: (pane: WebPane) => void
  /** Default Notebook's choices, in Library order: names only, never a note. */
  readonly notebooks: () => readonly NotebookChoice[]
}

const isWebPane = (value: unknown): value is WebPane => WEB_PANES.some((pane) => pane === value)

export function settingsHandlers(settings: NativeSettings): ScreensHandlers {
  return {
    'settings.showPane': async (args) => {
      const pane = args['pane']
      if (!isWebPane(pane)) throw new Error('E_SCREENS_ARGS_INVALID')
      settings.showPane(pane)
      return {}
    },
    'settings.notebooks': async () => ({ notebooks: settings.notebooks() }),
  }
}
