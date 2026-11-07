import { useEffect, useRef, useState, type RefObject } from 'react'
import { useEditorSetting } from '../editorSettings'
import { editorOnly, type Mode } from '../ModeControl'
import { syncScrolling, type ScrollPane } from '../preview/scrollSync'
import { hideScrolledBy, isScrolled, showScrolledBy } from '../scrollEdge'

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
    // On the element whose fade it sizes: on .panes or .content it would restyle every block of the preview.
    const faded = new Set<HTMLElement>()
    const show = (pane: HTMLElement | null, top: number) => {
      if (!pane) return
      faded.add(pane)
      showScrolledBy(pane, top)
    }
    const update = () => {
      const editorTop = editorPane?.element.scrollTop ?? 0
      const previewTop = previewPane?.element.scrollTop ?? 0
      const editor = isScrolled(editorTop)
      const preview = isScrolled(previewTop)
      panes.toggleAttribute('data-editor-scrolled', editor)
      panes.toggleAttribute('data-preview-scrolled', preview)
      if (mode === 'split') {
        show(panes.querySelector<HTMLElement>(':scope > .editor'), editorTop)
        show(panes.querySelector<HTMLElement>(':scope > .preview'), previewTop)
      } else show(panes, editorOnly(mode) ? editorTop : previewTop)
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
      for (const pane of faded) hideScrolledBy(pane)
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
