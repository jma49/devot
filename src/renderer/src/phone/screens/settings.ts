import type { NotebookChoice } from '../../notebookChoices'
import type { ScreensHandlers } from './ops'

/** The Settings panes the page still draws under the native Settings, until each is native. */
export const WEB_PANES = ['appearance', 'sync'] as const
export type WebPane = (typeof WEB_PANES)[number]

/** A place in a pane it opens scrolled to: Sync's pairing, for the root's Pair a device. */
export type PaneAnchor = 'pairing'
const ANCHORS: Readonly<Record<PaneAnchor, WebPane>> = { pairing: 'sync' }

export interface NativeSettings {
  readonly showPane: (pane: WebPane, anchor?: PaneAnchor) => void
  /** Default Notebook's choices, in Library order: names only, never a note. */
  readonly notebooks: () => readonly NotebookChoice[]
}

const isWebPane = (value: unknown): value is WebPane => WEB_PANES.some((pane) => pane === value)
const isAnchor = (value: unknown): value is PaneAnchor =>
  typeof value === 'string' && Object.hasOwn(ANCHORS, value)

export function settingsHandlers(settings: NativeSettings): ScreensHandlers {
  return {
    'settings.showPane': async (args) => {
      const pane = args['pane']
      const anchor = args['anchor']
      if (!isWebPane(pane)) throw new Error('E_SCREENS_ARGS_INVALID')
      if (anchor === undefined) {
        settings.showPane(pane)
        return {}
      }
      if (!isAnchor(anchor) || ANCHORS[anchor] !== pane) throw new Error('E_SCREENS_ARGS_INVALID')
      settings.showPane(pane, anchor)
      return {}
    },
    'settings.notebooks': async () => ({ notebooks: settings.notebooks() }),
  }
}
