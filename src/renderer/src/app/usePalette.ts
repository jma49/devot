import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { NoteSummary, TagRecord } from '../../../core'
import type { BookNode } from '../../../core/books'
import { visible } from '../areas'
import { inEditor, sheetOpen, useMenuEvent } from '../commands/dispatch'
import type { EditorHandle } from '../editor/handle'
import { newestUntitled, useHeadlines, type HeadlineLoader } from '../headlines'
import type { ImageMenuTarget } from '../imageMenu'
import { libraryEntries, outlineEntries } from '../palette/entries'
import type { PaletteSource } from '../palette/results'

const SHOW_PALETTE = 'devot:show-palette'

/** How many untitled notes the palette looks up the first line of (the newest). */
const PALETTE_HEADLINES = 500

interface FocusReturn {
  editor: boolean
  element: HTMLElement | null
}

/** The command palette: what it was opened over, and where the keyboard goes once it closes. */
export function usePalette(editorRef: RefObject<EditorHandle | null>) {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteScope, setPaletteScope] = useState<PaletteSource | undefined>()
  const [paletteText, setPaletteText] = useState('')
  // Read once per text change: the outline of a long note need not be rebuilt on every render.
  const paletteOutline = useMemo(
    () => (paletteOpen ? outlineEntries(paletteText) : []),
    [paletteOpen, paletteText],
  )
  const [paletteLines, setPaletteLines] = useState(0)
  const [paletteInTable, setPaletteInTable] = useState(false)
  const [paletteSelection, setPaletteSelection] = useState(false)
  const [paletteLink, setPaletteLink] = useState(false)
  const [paletteImage, setPaletteImage] = useState<ImageMenuTarget | null>(null)
  const paletteReturn = useRef<FocusReturn>(undefined)
  // While a palette action picked from the editor runs, a note it opens
  // takes the keyboard into its editor.
  const paletteFromEditor = useRef(false)
  // Counts palette actions that have finished; see `closePalette`.
  const [paletteDone, setPaletteDone] = useState(0)
  const openPalette = (scope?: PaletteSource) => {
    if (sheetOpen()) return
    const element = document.activeElement
    paletteReturn.current = {
      editor: inEditor(element),
      element: element instanceof HTMLElement ? element : null,
    }
    setPaletteInTable(editorRef.current?.inTable() ?? false)
    setPaletteSelection(editorRef.current?.hasSelection() ?? false)
    setPaletteLink(editorRef.current?.linkAtCursor() != null)
    setPaletteImage(editorRef.current?.imageAtCursor() ?? null)
    const text = editorRef.current?.text() ?? ''
    setPaletteText(text)
    let lines = 1
    for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) lines++
    setPaletteLines(lines)
    setPaletteScope(scope)
    setPaletteOpen(true)
  }
  /** Returns the keyboard, then runs the picked action; once it is done and rendered, the effect below checks the keyboard is still visible. */
  const closePalette = (picked?: () => void | Promise<unknown>) => {
    setPaletteOpen(false)
    const back = paletteReturn.current
    paletteReturn.current = undefined
    if (back?.editor && editorRef.current) editorRef.current.focus()
    else if (back?.element?.isConnected) back.element.focus()
    paletteFromEditor.current = back?.editor ?? false
    void (async () => {
      try {
        await picked?.()
      } catch {
        console.warn('W_PALETTE_ACTION_FAILED')
      } finally {
        paletteFromEditor.current = false
        setPaletteDone((n) => n + 1)
      }
    })()
  }
  return {
    paletteOpen,
    paletteScope,
    paletteOutline,
    paletteLines,
    paletteInTable,
    paletteSelection,
    paletteLink,
    paletteImage,
    paletteFromEditor,
    paletteDone,
    openPalette,
    closePalette,
  }
}

/** Opens the palette from the menu bar, and checks the keyboard is still visible once a picked action is done. */
export function usePaletteKeyboard({
  editorRef,
  paletteDone,
  openPalette,
}: {
  editorRef: RefObject<EditorHandle | null>
  paletteDone: number
  openPalette: () => void
}) {
  // The action may have hidden or removed what had the keyboard (Show Preview, focus mode, Move to Trash, opening another note): then the open note's row, editor, title or a toolbar button takes it. A note opened from the editor takes it back once loaded (`takesKeyboard`).
  useEffect(() => {
    if (paletteDone === 0) return
    const now = document.activeElement
    if (now instanceof HTMLElement && now !== document.body && visible(now)) return
    const row = document.querySelector<HTMLElement>('.list [role="option"][tabindex="0"]')
    const editor = document.querySelector<HTMLElement>('[data-devot-part="editor-body"]')
    const titleField = document.querySelector<HTMLElement>('input.title')
    if (visible(row)) row.focus()
    else if (visible(editor) && editorRef.current) editorRef.current.focus()
    else if (visible(titleField)) titleField.focus()
    else {
      const tools = document.querySelectorAll<HTMLElement>(
        '[data-devot-part="toolbar"] button:not(:disabled)',
      )
      Array.from(tools).find(visible)?.focus()
    }
  }, [paletteDone, editorRef])
  useMenuEvent('devot://show-palette', SHOW_PALETTE, () => openPalette())
}

/** Notebooks, tags and notes for the palette, gathered only while it is open and again only when they change. */
export function usePaletteLibrary({
  paletteOpen,
  notes,
  tree,
  tags,
  loadHeadlines,
}: {
  paletteOpen: boolean
  notes: NoteSummary[]
  tree: BookNode[]
  tags: TagRecord[]
  loadHeadlines: HeadlineLoader | undefined
}) {
  const paletteUntitled = useMemo(
    () => (paletteOpen ? newestUntitled(notes, PALETTE_HEADLINES) : []),
    [paletteOpen, notes],
  )
  const paletteHeadlines = useHeadlines(loadHeadlines, paletteUntitled)
  const paletteLibrary = useMemo(
    () =>
      paletteOpen ? libraryEntries({ tree, tags, notes, headlines: paletteHeadlines }) : undefined,
    [paletteOpen, tree, tags, notes, paletteHeadlines],
  )
  return paletteLibrary
}
