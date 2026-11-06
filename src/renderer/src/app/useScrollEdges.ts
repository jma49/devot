import { useEffect, useRef, useState, type RefObject } from 'react'
import { useEditorSetting } from '../editorSettings'
import { editorOnly, type Mode } from '../ModeControl'
import { syncScrolling, type ScrollPane } from '../preview/scrollSync'
import { isScrolled, scrolledBy } from '../scrollEdge'

/** The open note's scroll panes: the edges they show scrolled, and Split keeping them at the same line. */
export function useScrollEdges({
  panesRef,
  mode,
  selected,
}: {
  panesRef: RefObject<HTMLDivElement | null>
  mode: Mode
  selected: string | undefined
}) {
  // Split mode keeps editor and preview at the same line unless synced scrolling is off (an editor setting).
  const syncScroll = useEditorSetting('syncScroll')
  const [editorPane, setEditorPane] = useState<ScrollPane | null>(null)
  const [previewPane, setPreviewPane] = useState<ScrollPane | null>(null)
  useEffect(() => {
    const panes = panesRef.current
    const content = panes?.closest('.content')
    if (!panes || !content) return
    const style = (el: Element) => (el as HTMLElement).style
    const update = () => {
      const editorTop = editorPane?.element.scrollTop ?? 0
      const previewTop = previewPane?.element.scrollTop ?? 0
      const editor = isScrolled(editorTop)
      const preview = isScrolled(previewTop)
      const leadTop = editorOnly(mode) ? editorTop : mode === 'preview' ? previewTop : 0
      panes.toggleAttribute('data-editor-scrolled', editor)
      panes.toggleAttribute('data-preview-scrolled', preview)
      style(panes).setProperty('--editor-scrolled-by', scrolledBy(editorTop))
      style(panes).setProperty('--preview-scrolled-by', scrolledBy(previewTop))
      style(content).setProperty('--pane-scrolled-by', scrolledBy(leadTop))
      content.toggleAttribute(
        'data-scrolled',
        editorOnly(mode) ? editor : mode === 'preview' ? preview : editor || preview,
      )
    }
    const scrollers = [editorPane?.element, previewPane?.element].filter((el) => !!el)
    for (const el of scrollers) el.addEventListener('scroll', update, { passive: true })
    update()
    return () => {
      for (const el of scrollers) el.removeEventListener('scroll', update)
      content.removeAttribute('data-scrolled')
      style(content).removeProperty('--pane-scrolled-by')
      style(panes).removeProperty('--editor-scrolled-by')
      style(panes).removeProperty('--preview-scrolled-by')
      panes.removeAttribute('data-editor-scrolled')
      panes.removeAttribute('data-preview-scrolled')
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Another note starts at the top, so the scroll edges are read again.
  }, [panesRef, editorPane, previewPane, mode, selected])
  // Coming from Preview, the place being read leads; otherwise the editor does.
  const modeBefore = useRef(mode)
  useEffect(() => {
    const lead = modeBefore.current === 'preview' ? 'second' : 'first'
    modeBefore.current = mode
    if (mode !== 'split' || !syncScroll || !editorPane || !previewPane) return
    return syncScrolling(editorPane, previewPane, { lead })
  }, [mode, syncScroll, editorPane, previewPane])
  return { syncScroll, editorPane, setEditorPane, previewPane, setPreviewPane }
}
