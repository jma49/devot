// Edit with AI: the presets as a native menu, under the selection toolbar's AI button and as a submenu of the editor's
// menu. Picking one hands the selection to the window, which asks for a proposal (AiEditSheet).
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { useCallback } from 'react'
import type { AiEditPreset } from '../../../core/aiEdit'
import { useContextMenu, type MenuEntry, type MenuGroups } from '../contextMenu'
import type { MessageKey } from '../i18n'

export type AiEditChoice = AiEditPreset | 'prompt'

/** The selected text the proposal is for: `from` locates it again when the proposal is accepted. */
export interface AiEditStart {
  from: number
  text: string
  choice: AiEditChoice
}

export type StartAiEdit = (start: AiEditStart) => void

export type ShowAiMenu = (view: EditorView, anchor: Element) => Promise<void>

export const aiChoiceLabel = (choice: AiEditChoice): MessageKey => `aiEdit.preset.${choice}`

const GROUPS: readonly (readonly AiEditChoice[])[] = [
  ['improve', 'proofread', 'reformat'],
  ['summarize'],
  ['bulletList', 'taskList', 'table', 'headings', 'mermaid'],
  ['prompt'],
]

export function aiMenuEntries<A extends string, T>(
  action: (choice: AiEditChoice) => A,
): MenuEntry<A, T>[][] {
  return GROUPS.map((group) =>
    group.map((choice) => ({ action: action(choice), label: aiChoiceLabel(choice) })),
  )
}

export interface AiMenuTarget {
  view: EditorView
}

export const AI_MENU: MenuGroups<AiEditChoice, AiMenuTarget> = aiMenuEntries((choice) => choice)

/** The main selection, or null when it is empty or only white space. */
export function aiEditSelection(state: EditorState): { from: number; text: string } | null {
  const { from, to } = state.selection.main
  const text = state.sliceDoc(from, to)
  return text.trim() === '' ? null : { from, text }
}

export function aiEditStart(state: EditorState, choice: AiEditChoice): AiEditStart | null {
  const selection = aiEditSelection(state)
  return selection && { ...selection, choice }
}

export function useAiMenu(start: (view: EditorView, choice: AiEditChoice) => void): ShowAiMenu {
  const pick = useCallback(
    (choice: AiEditChoice, target: AiMenuTarget) => start(target.view, choice),
    [start],
  )
  const show = useContextMenu('aiEdit', AI_MENU, pick)
  return useCallback(
    (view: EditorView, anchor: Element) => {
      const box = anchor.getBoundingClientRect()
      return show({ view }, { x: box.left, y: box.bottom })
    },
    [show],
  )
}
