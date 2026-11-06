import { useRef, useState, type RefObject } from 'react'
import { useEditorSetting } from '../editorSettings'
import type { EditorHandle } from '../editor/handle'
import { editorOnly, type Mode } from '../ModeControl'
import { lineStore } from '../outline/OutlinePanel'
import { scrollPreviewTo } from '../outline/room'
import { useOutlineRoom } from '../outline/useOutlineRoom'
import type { ScrollPane } from '../preview/scrollSync'

/** The open note's outline: whether it shows, its folds per note, and the heading it jumps to. */
export function useOutline({
  panesRef,
  mode,
  selected,
  focus,
  editorRef,
  previewPane,
}: {
  panesRef: RefObject<HTMLDivElement | null>
  mode: Mode
  selected: string | undefined
  focus: boolean
  editorRef: RefObject<EditorHandle | null>
  previewPane: ScrollPane | null
}) {
  const outlineSetting = useEditorSetting('outline')
  const [caretLine] = useState(() => lineStore())
  // In a ref, so folding one note does not render App again.
  const outlineFolds = useRef(new Map<string, ReadonlySet<string>>())
  const [, setFolded] = useState(0)
  const outlineRoom = useOutlineRoom(panesRef, mode, selected)
  const outlineShown = outlineSetting && !focus && outlineRoom
  const toggleOutlineFold = (key: string) => {
    if (selected === undefined) return
    const next = new Set(outlineFolds.current.get(selected))
    if (!next.delete(key)) next.add(key)
    outlineFolds.current.set(selected, next)
    setFolded((n) => n + 1)
  }
  const jumpToHeading = (line: number) => {
    editorRef.current?.goToLine(line, 'start', false)
    if (!editorOnly(mode) && previewPane) scrollPreviewTo(previewPane, line)
  }
  return { outlineShown, caretLine, outlineFolds, toggleOutlineFold, jumpToHeading }
}
