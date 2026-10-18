// The preview's context menu: a native menu for a right-click in the
// rendered note (images have their own, `imageMenu.ts`). A link gets Copy
// Link Address; a selection gets Look Up and Copy; Select All covers the
// note's preview alone, not the window.
import { shownGroups, type MenuEntry, type MenuGroups } from '../contextMenu'
import { lookUpLabel, lookUpSelection } from '../textServices'

export type PreviewAction =
  | 'copyLink'
  | 'lookUp'
  | 'copy'
  | 'selectAll'
  | 'speech'
  | 'startSpeaking'
  | 'stopSpeaking'

/** What the menu needs to know about where it opened. */
export interface PreviewMenuTarget {
  /** The address of the link under the pointer, if it is one the app opens. */
  link: string | null
  /** The selected text to look up and speak, if any. */
  selection: string | null
}

const SPEECH: MenuEntry<PreviewAction, PreviewMenuTarget>[] = [
  { action: 'startSpeaking', label: 'editorMenu.startSpeaking' },
  { action: 'stopSpeaking', label: 'editorMenu.stopSpeaking' },
]

export const PREVIEW_MENU: MenuGroups<PreviewAction, PreviewMenuTarget> = [
  [{ action: 'copyLink', label: 'editorMenu.copyLink', shown: (t) => t.link !== null }],
  [
    {
      action: 'lookUp',
      label: 'editorMenu.lookUp',
      shown: (t) => t.selection !== null,
      text: (t) => lookUpLabel(t.selection ?? ''),
    },
  ],
  [
    { action: 'copy', label: 'editorMenu.copy', predefined: 'Copy' },
    { action: 'selectAll', label: 'editorMenu.selectAll' },
  ],
  [{ action: 'speech', label: 'editorMenu.speech', submenu: SPEECH }],
]

/** Whether the menu has anything to show for a target. */
export const previewMenuHasItems = (target: PreviewMenuTarget): boolean =>
  shownGroups(PREVIEW_MENU, target).length > 0

/** The address of a link the app opens (a web page or a note), else null. */
export function openableHref(href: string | null): string | null {
  if (href === null) return null
  return /^https:\/\//i.test(href) || /^devot:\/\//i.test(href) ? href : null
}

/** The menu's target: the link element (if any) and the page's selected text. */
export function previewMenuTarget(
  link: Element | null,
  selected: string | null | undefined,
): PreviewMenuTarget {
  return {
    link: openableHref(link?.getAttribute('href') ?? null),
    selection: lookUpSelection(selected),
  }
}

/** Selects the contents of `pane` alone (Select All in the preview). */
export function selectAllIn(pane: Element, selection: Selection | null): void {
  selection?.selectAllChildren(pane)
}
