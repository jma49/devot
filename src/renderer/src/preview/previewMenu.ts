// The preview's context menu: a native menu for a right-click in the
// rendered note (images have their own, `imageMenu.ts`). A link gets Copy
// Link Address; a selection gets Look Up and Copy; Select All covers the
// note's preview alone, not the window.
import type { MenuEntry, MenuGroups, MenuPoint } from '../contextMenu'
import {
  fontDescent,
  lookUpFont,
  lookUpLabel,
  lookUpOrigin,
  lookUpSelection,
  type LookUpFont,
} from '../textServices'

export type PreviewAction =
  | 'copyLink'
  | 'lookUp'
  | 'copy'
  | 'selectAll'
  | 'speech'
  | 'startSpeaking'
  | 'stopSpeaking'

export interface PreviewMenuTarget {
  link: string | null
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

/** The address of a link the app opens (a web page or a note), else null. */
export function openableHref(href: string | null): string | null {
  if (href === null) return null
  return /^https:\/\//i.test(href) || /^devot:\/\//i.test(href) ? href : null
}

export function previewMenuTarget(
  link: Element | null,
  selected: string | null | undefined,
): PreviewMenuTarget {
  return {
    link: openableHref(link?.getAttribute('href') ?? null),
    selection: lookUpSelection(selected),
  }
}

export function selectAllIn(pane: Element, selection: Selection | null): void {
  selection?.selectAllChildren(pane)
}

export interface SelectedRun {
  text: string
  start: number
  end: number
}

/**
 * The first character of a selection after any white space: the run it is
 * in and its offset and length there (a surrogate pair is one character);
 * null when the selection is all white space.
 */
export function firstCharacter(
  runs: readonly SelectedRun[],
): { run: number; offset: number; length: number } | null {
  for (const [run, { text, start, end }] of runs.entries()) {
    const at = text.slice(start, end).search(/\S/)
    if (at < 0) continue
    const offset = start + at
    const code = text.codePointAt(offset) ?? 0
    return { run, offset, length: code > 0xffff ? 2 : 1 }
  }
  return null
}

/**
 * Where Look Up gets a selection in the preview and the font it draws the
 * word in, as the editor does (`lookUpTarget`): the baseline origin of its
 * first character after white space and that character's computed font;
 * null when there is none or it has no box.
 */
export function previewLookUpTarget(
  range: Range,
): { at: MenuPoint; font: LookUpFont | null } | null {
  const nodes: Text[] = []
  const root = range.commonAncestorContainer
  if (root instanceof Text) nodes.push(root)
  else {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node instanceof Text && range.intersectsNode(node)) nodes.push(node)
    }
  }
  const runs = nodes.map((node) => ({
    text: node.data,
    start: node === range.startContainer ? range.startOffset : 0,
    end: node === range.endContainer ? range.endOffset : node.data.length,
  }))
  const first = firstCharacter(runs)
  const node = first ? nodes[first.run] : undefined
  if (!first || !node) return null
  const character = document.createRange()
  character.setStart(node, first.offset)
  character.setEnd(node, first.offset + first.length)
  const box = character.getClientRects()[0] ?? character.getBoundingClientRect()
  if (box.width === 0 && box.height === 0) return null
  const element = node.parentElement
  const style = element ? getComputedStyle(element) : null
  return {
    at: lookUpOrigin(box, style ? fontDescent(style) : 0),
    font: style ? lookUpFont(style) : null,
  }
}
