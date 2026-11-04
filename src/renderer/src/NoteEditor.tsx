import { isolateHistory } from '@codemirror/commands'
import { Compartment, EditorSelection, EditorState, Prec, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { yCollab, ySyncAnnotation } from 'y-codemirror.next'
import * as Y from 'yjs'
import { readWrites, type AgentWrite } from '../../core/authorship'
import { BODY } from '../../core/notes'
import { authorshipMarks } from './editor/authorship'
import { authorshipUndo, undoneWrites } from './editor/authorshipUndo'
import { imageFiles, storeImages } from './attachments'
import { DRAG_BOOK, DRAG_NOTE } from './dragData'
import { errorCode } from '../../core/errors'
import { anchorAt, insertAtAnchor, trackOpenEditor } from './editor/anchoredInsert'
import { invoke } from './ipc'
import { linkOpener, lineCommands } from './editor/lineCommands'
import { overwrite } from './editor/overwrite'
import {
  EDITOR_MENU,
  editorMenu,
  editorMenuTarget,
  lookUpTarget,
  replaceWord,
  spellingWordAt,
  type WordRange,
  type EditorAction,
  type EditorMenuTarget,
} from './editor/editorMenu'
import { redo, undo } from '@codemirror/commands'
import { tauriMenus, useContextMenu, type MenuPoint } from './contextMenu'
import { copyText } from './noteMenu'
import { lookUp, startSpeaking, stopSpeaking } from './textServices'
import type { ShowAlertMenu } from './editor/alertMenu'
import { trackExtract } from './editor/extract'
import { editorFind, editorFindTarget } from './editor/find'
import { formatToolbar } from './editor/FormatToolbar'
import { noteHighlighting } from './editor/highlighting'
import { systemMenus, systemMenusAvailable } from './editor/systemMenu'
import type { Suggester } from '../../core/aiSuggest'
import { aiEditStart, useAiMenu, type AiEditChoice, type StartAiEdit } from './editor/aiMenu'
import { ghostText } from './editor/ghostText'
import { imageSizeBar } from './editor/ImageSizeBar'
import { tableToolbar } from './editor/TableToolbar'
import { linkTooltip } from './editor/linkTooltip'
import { noteLinkHover } from './editor/noteLinkHover'
import { previewsFor } from './notePreview'
import { formatKeyAvailability } from './editor/formatKeys'
import { imeKeys } from './editor/imeKeys'
import {
  earlyKeysKeptForAnother,
  replayEarlyKeys,
  startEarlyKeys,
  takeEarlyKeys,
  type EarlyKeysTicket,
} from './editor/earlyKeys'
import {
  imageCommandKeys,
  newFromLink,
  newFromLinkKeys,
  newFromSelection,
  newFromSelectionKeys,
  pastePlain,
  pastePlainKeys,
  pasteUrlAsKeys,
} from './editor/noteKeys'
import { editorLayoutWatch, editorScrollPane } from './editor/scrollPane'
import { editorHandle, REMOTE, type EditorHandle } from './editor/handle'
import { shadowContainer } from './editor/shadowFrame'
import { editorTheme, popupSpace } from './editor/theme'
import { insertKeymap } from './editor/insert'
import { imageActions } from './editor/images'
import { tableKeymap } from './editor/tableCommands'
import { tableTyping } from './editor/tableTyping'
import { markdownLineStyles } from './editor/lineStyles'
import { noteHighlightStyle, noteMarkdown } from './editor/markdown'
import { pasteUrls } from './editor/paste'
import { pasteChooser, type PasteFetcher } from './editor/pasteChooser'
import { editorSetup, reconfigureSetup } from './editor/settings'
import { countsReporter, recount, type EditorCounts } from './editor/counts'
import { selectionEdges } from './editor/selectionEdges'
import { editorCompletions } from './editor/completions'
import { chooseTemplate } from './editor/hints'
import { setToolbarFocus } from './editor/toolbarState'
import { keepUndo, noteState, yjsHistory } from './editor/undo'
import { catchUp } from './editor/catchUp'
import { refusedEdits } from './editor/refusedEdits'
import { reconfigureRegistryKeys } from './editor/registryKeys'
import { setInertFormats } from './commands/formatMenu'
import { subscribeKeymap } from './commands/shortcutSettings'
import { FONT_SLOTS } from '../../core/editorSettings'
import { subscribeFontsLoaded } from './fonts'
import { useEditorSettings } from './editorSettings'
import type { FindTarget } from './find/target'
import { keyboardIsFree, typingElsewhere } from './focus'
import { t } from './i18n'
import { imageMenuTarget, type ShowImageMenu } from './imageMenu'
import type { ViewedImage } from './ImageViewer'
import { linkCompletion, type LinkSources } from './linkCompletion'
import { setWriteFocus, writeFocusTracking, writeMode, type WriteRenderer } from './editor/write'
import { previewLabels } from './preview/Preview'
import type { Core } from './core-client'
import type { ScrollPane } from './preview/scrollSync'
import { clampSelection, clampTop, type EditorTop, type SelectionState } from './lastState'

// The note being left while the next one loads: on screen, but nothing typed may land in it.
const pausedSlot = new Compartment()
const PAUSED = [
  EditorView.editable.of(false),
  EditorState.readOnly.of(true),
  // Not offered as the body to type into until the next note is.
  EditorView.contentAttributes.of({ 'aria-hidden': 'true' }),
]
// Notes are read-only once the trial is over without a licence: the text can be read, selected and
// copied, and only what another replica sends (Yjs) still changes it.
const lockedSlot = new Compartment()
const LOCKED = [
  EditorState.readOnly.of(true),
  EditorState.changeFilter.of((tr) => tr.annotation(ySyncAnnotation) !== undefined),
  Prec.highest(
    EditorView.domEventHandlers({
      paste: (event) => {
        event.preventDefault()
        return true
      },
      drop: (event) => {
        event.preventDefault()
        return true
      },
    }),
  ),
]
// WebKit keeps a contenteditable's selection when focus moves to a sheet or the history bar, and
// runs Backspace and typing against it even under `inert` or a modal: the note out of sight would
// change. The change is dropped and the editor draws its own text again. It comes first among the
// highest-precedence handlers so no other one (close brackets, backticks, table typing, overwrite)
// dispatches the change before the check runs.
const ONLY_WHILE_FOCUSED = Prec.highest(EditorView.inputHandler.of((view) => !view.hasFocus))
// View > Show Authorship (editor/authorship.ts), set for the replica of the note shown.
const authorshipSlot = new Compartment()
// The empty note's Choose a Template chip: only where the window can run it on a note that may change.
const templateSlot = new Compartment()
const templateChip = (offered: boolean, run: { readonly current: (() => void) | undefined }) =>
  offered ? chooseTemplate.of(() => run.current?.()) : []
// Write mode (editor/write): the editor itself, so the caret, the history and the place are kept.
const writeSlot = new Compartment()
const writeFor = (on: boolean, core: Core) =>
  on ? writeMode({ loadNote: previewsFor(core), render: blockRenderer(core) }) : []

/** Write mode's images, formulas and diagrams, by the preview's renderers in the core. */
const blockRenderer = (core: Core): WriteRenderer => ({
  render: (markdown, loadedEmbeds) =>
    core
      .renderPreviewPieces(
        markdown,
        { labels: previewLabels(), loadedEmbeds: [...loadedEmbeds] },
        [],
      )
      .then((pieces) => pieces.flatMap((piece) => piece.nodes ?? [])),
})
const marksFor = (on: boolean, doc: Y.Doc, noteId: string) =>
  on ? authorshipMarks(doc, noteId) : []
/** A restored version: the core made it, and undo takes it back (editor/undo.ts). */
const RESTORE = 'restore'

export type ApplyRestore = (update: Uint8Array) => void

export interface EditorPlace {
  selection: SelectionState
  top?: EditorTop
}

/** What the paste chooser fetches, through Rust (https only, capped). */
const linkFetcher: PasteFetcher = {
  title: async (url) => {
    const title = await invoke<unknown>('link_title', { url })
    return typeof title === 'string' ? title : null
  },
  snippet: async (url) => {
    const code = await invoke<unknown>('github_snippet', { url })
    if (typeof code !== 'string') throw new Error('E_LINK_FAILED')
    return code
  },
}

/** The top line and the offset past its top. The scroll box is `scroller` (inside the shadow root), not CodeMirror's own. */
function editorTop(view: EditorView, scroller: HTMLElement): EditorTop | undefined {
  // Hidden (preview mode): it shows nothing, so it keeps the place it had.
  if (scroller.clientHeight === 0) return undefined
  const y = scroller.getBoundingClientRect().top - view.documentTop
  const block = view.lineBlockAtHeight(y)
  return { pos: block.from, offset: y - block.top }
}

/** Scrolls the editor so that `top` is where it was (a line gone since: the end). */
function scrollToTop(view: EditorView, scroller: HTMLElement, top: EditorTop) {
  view.requestMeasure({
    read: (v) => {
      const y = scroller.getBoundingClientRect().top - v.documentTop
      const target = v.lineBlockAt(Math.min(top.pos, v.state.doc.length)).top + top.offset
      return scroller.scrollTop + target - y
    },
    write: (scrollTop) => {
      scroller.scrollTop = scrollTop
    },
  })
}

/**
 * Stores pasted or dropped images and inserts their links at a position that follows edits made meanwhile; if the editor closed by then the link still goes into the note (editor/anchoredInsert.ts). Images that could not be stored go to `refused` with their codes.
 */
function attachImages(
  core: Core,
  noteId: string,
  text: Y.Text,
  refused: (codes: string[]) => void,
): { extension: Extension; choose: (view: EditorView) => void } {
  const insert = (view: EditorView, pos: number, files: File[]) => {
    const anchor = anchorAt(text, Math.min(pos, view.state.doc.length))
    void storeImages(noteId, files).then(async (stored) => {
      if (stored.refused.length > 0) refused(stored.refused)
      if (!stored.links) return
      await insertAtAnchor(core, noteId, anchor, stored.links).catch((e: unknown) => {
        // The note was deleted meanwhile; its files go with it.
        console.warn('W_IMAGE_LINK_NOT_INSERTED', noteId, errorCode(e))
      })
    })
  }
  const choose = (view: EditorView) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.multiple = true
    input.hidden = true
    const pos = view.state.selection.main.head
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])].filter((f) => f.type.startsWith('image/'))
      input.remove()
      if (files.length > 0) insert(view, pos, files)
    })
    input.addEventListener('cancel', () => input.remove())
    document.body.appendChild(input)
    input.click()
  }
  const extension = EditorView.domEventHandlers({
    paste(event, view) {
      const files = imageFiles(event.clipboardData)
      if (files.length === 0) return false
      event.preventDefault()
      insert(view, view.state.selection.main.head, files)
      return true
    },
    drop(event, view) {
      const links = event.dataTransfer?.types.includes(DRAG_NOTE)
        ? event.dataTransfer.getData('text/plain')
        : ''
      if (links) {
        event.preventDefault()
        const at = view.posAtCoords({ x: event.clientX, y: event.clientY })
        const pos = at ?? view.state.selection.main.head
        view.dispatch({
          changes: { from: pos, insert: links },
          selection: { anchor: pos + links.length },
          annotations: isolateHistory.of('full'),
          userEvent: 'input.drop',
        })
        view.focus()
        return true
      }
      // A notebook dropped here: its text is not for the note.
      if (event.dataTransfer?.types.includes(DRAG_BOOK)) {
        event.preventDefault()
        return true
      }
      const files = imageFiles(event.dataTransfer)
      if (files.length === 0) return false
      event.preventDefault()
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
      insert(view, pos ?? view.state.selection.main.head, files)
      return true
    },
  })
  return { extension, choose }
}

interface Shown {
  core: Core
  noteId: string
  doc: Y.Doc
  place: EditorPlace
  handle: EditorHandle
  applyStep: ApplyRestore
  /** Lets the note go; `left` is the editor state it was left with. */
  close: (left: EditorState) => void
}

interface EditorBox {
  view: EditorView
  settings: ReturnType<typeof useEditorSettings>
}

interface Props {
  core: Core
  /** Changing it keeps the note shown until the next one has loaded, then swaps the view's state. */
  noteId: string
  /** A body the window opened and holds (`core.hold`) for this note, if any: the editor takes it and the hold. */
  takePreopened?: (core: Core, noteId: string) => Uint8Array | undefined
  /** Whether a note is loading while the previous one stays on screen. */
  onLoading?: (loading: boolean) => void
  /** Focus the body once it loads (a note just created, or Cmd+Return on its row). */
  autoFocus: boolean
  /** With `autoFocus`: only if nothing has the keyboard when the body has loaded (a restore). */
  autoFocusIfFree?: boolean
  /** Kept mounted but out of sight in preview mode, so the text stays live. */
  hidden: boolean
  /** Write mode: the marks of the lines without the caret hidden. */
  write?: boolean
  onText: (text: string) => void
  /** Once this editor has its note's body; never for an editor being left, unlike `onText`, which then reports an empty body. */
  onLoaded?: (text: string) => void
  links: LinkSources
  /** Set while the note is open: applies a restored version (see ApplyRestore). */
  restoreRef?: RefObject<ApplyRestore | null>
  onFind?: (target: FindTarget | null) => void
  showAlertMenu: ShowAlertMenu
  handleRef?: RefObject<EditorHandle | null>
  onScrollPane?: (pane: ScrollPane | null) => void
  onOpenImage?: (image: ViewedImage) => void
  showImageMenu?: ShowImageMenu
  /** Where to put the user when the note has loaded, asked once; positions past the end go to the end. */
  initialPlace?: () => Partial<EditorPlace> | undefined
  /** The selection changed or the editor scrolled. The top line is measured only on a scroll, never on a keystroke, and follows edits above it. */
  onPlace?: (noteId: string, place: EditorPlace) => void
  /** Words and characters of the note and the selection, once typing pauses; nothing is counted without it. */
  onCounts?: ((counts: EditorCounts) => void) | undefined
  /** The line the caret is on, when it moves to another or the note changes under it. */
  onCaretLine?: ((line: number) => void) | undefined
  onNewFromSelection?: (() => void) | undefined
  /** Edit with AI on the selection (the toolbar's AI button and the editor menu); left out where AI may not edit. */
  onAiEdit?: StartAiEdit | undefined
  /** Next edit suggestions (ghost text); left out where AI may not edit, and the suggestion keys then answer that it may not. */
  suggester?: Suggester | undefined
  /** The user asked for a suggestion and got none; the code says why. */
  onSuggestFailed?: ((code: string) => void) | undefined
  onNewFromLink?: (() => void) | undefined
  onImagesRefused?: (codes: string[]) => void
  onOpenFailed?: (noteId: string, code: string) => void
  /** The core refused typing (the note purged elsewhere, a body over the limit); it is logged either way. */
  onEditRefused?: (noteId: string, code: string) => void
  onChooseTemplate?: (() => void) | undefined
  onOpenNote?: (noteId: string) => void
  /** Shown but not changed: the trial is over without a licence. */
  readOnly?: boolean
}

export function NoteEditor({
  core,
  noteId,
  takePreopened,
  onLoading,
  autoFocus,
  autoFocusIfFree = false,
  hidden,
  write = false,
  onText,
  onLoaded,
  links,
  restoreRef,
  onFind,
  showAlertMenu,
  handleRef,
  onScrollPane,
  onOpenImage,
  showImageMenu,
  initialPlace,
  onPlace,
  onCounts,
  onCaretLine,
  onNewFromSelection,
  onAiEdit,
  suggester,
  onSuggestFailed,
  onNewFromLink,
  onImagesRefused,
  onOpenFailed,
  onEditRefused,
  onChooseTemplate,
  onOpenNote,
  readOnly = false,
}: Props) {
  const host = useRef<HTMLDivElement>(null)
  const locked = useRef(readOnly)
  // Read once, when the note has loaded.
  const focusOnOpen = useRef(autoFocus)
  const focusOnlyIfFree = useRef(autoFocusIfFree)
  const settings = useEditorSettings()
  const latestSettings = useRef(settings)
  const box = useRef<ReturnType<typeof shadowContainer> | null>(null)
  const editor = useRef<EditorBox | null>(null)
  const shown = useRef<Shown | null>(null)
  const loading = useRef(onLoading)
  const preopened = useRef(takePreopened)
  const alertMenu = useRef(showAlertMenu)
  const report = useRef(onText)
  const loaded = useRef(onLoaded)
  const linkSources = useRef(links)
  const findHandle = useRef(onFind)
  const scrollHandle = useRef(onScrollPane)
  const imageHandlers = useRef({ open: onOpenImage, menu: showImageMenu })
  const placeAsked = useRef(initialPlace)
  const placeReport = useRef(onPlace)
  const countsReport = useRef(onCounts)
  const caretLineReport = useRef(onCaretLine)
  const fromSelection = useRef(onNewFromSelection)
  const aiEdit = useRef(onAiEdit)
  const suggestions = useRef(suggester)
  const suggestFailed = useRef(onSuggestFailed)
  const startAiEdit = useCallback((view: EditorView, choice: AiEditChoice) => {
    const start = aiEditStart(view.state, choice)
    if (start) aiEdit.current?.(start)
  }, [])
  const showAiMenu = useAiMenu(startAiEdit)
  const aiMenu = useRef(showAiMenu)
  const fromLink = useRef(onNewFromLink)
  const imagesRefused = useRef(onImagesRefused)
  const openFailed = useRef(onOpenFailed)
  const editRefused = useRef(onEditRefused)
  const chooseTemplateRef = useRef(onChooseTemplate)
  const templateOffered = onChooseTemplate !== undefined && !readOnly
  const templateShown = useRef(templateOffered)
  const writing = useRef(write)
  const noteOpener = useRef(onOpenNote)
  const menuAt = useRef<MenuPoint>({ x: 0, y: 0 })
  const pickMenuAction = useCallback((action: EditorAction, target: EditorMenuTarget) => {
    const view = editor.current?.view
    if (!view) return
    switch (action) {
      case 'openLink':
        if (target.link !== null) view.state.facet(linkOpener)?.(target.link)
        return
      case 'copyLink': {
        const link = target.link
        if (link !== null) void copyText(link).catch(() => console.warn('W_LINK_COPY_FAILED'))
        return
      }
      case 'lookUp':
        // From the selection's first character, in its font, so the highlight covers the word.
        if (target.selection !== null) {
          const look = lookUpTarget(view)
          void lookUp(target.selection, look?.at ?? menuAt.current, look?.font)
        }
        return
      case 'newNote':
        view.state.facet(newFromSelection)?.()
        return
      case 'undo':
        undo(view)
        view.focus()
        return
      case 'redo':
        redo(view)
        view.focus()
        return
      case 'pastePlain':
        view.focus()
        void pastePlain(view)
        return
      case 'startSpeaking':
        void startSpeaking(target.selection)
        return
      case 'stopSpeaking':
        void stopSpeaking()
        return
      default:
        // The system's own items act on the web view; the submenus only hold items.
        if (action.startsWith('ai.')) {
          const start = aiEditStart(view.state, action.slice(3) as AiEditChoice)
          if (start) aiEdit.current?.(start)
        }
    }
  }, [])
  const menuWord = useRef<{ view: EditorView; word: WordRange } | null>(null)
  const showEditorMenu = useContextMenu('editor', EDITOR_MENU, pickMenuAction, async () =>
    systemMenusAvailable()
      ? systemMenus({
          word: () => menuWord.current?.word.text ?? null,
          replace: (guess) => {
            const at = menuWord.current
            if (at && !replaceWord(at.view, at.word, guess)) console.warn('W_SPELLING_WORD_CHANGED')
          },
        })
      : tauriMenus(),
  )
  const menuOpener = useRef<(view: EditorView, at: MenuPoint, pos: number | null) => void>(() => {})
  // Before the effect that shows a note, which reads them in the same commit.
  useLayoutEffect(() => {
    menuOpener.current = (view, at, pos) => {
      // The note being left, still on screen while the next one loads: its menu would act on the next.
      if (shown.current?.noteId !== noteId) return
      menuAt.current = at
      const target = editorMenuTarget(
        view.state,
        pos,
        fromSelection.current !== undefined,
        aiEdit.current !== undefined,
      )
      const word = spellingWordAt(view.state, pos)
      menuWord.current = word ? { view, word } : null
      void showEditorMenu(target, at)
    }
    chooseTemplateRef.current = onChooseTemplate
    aiEdit.current = onAiEdit
    suggestions.current = suggester
    suggestFailed.current = onSuggestFailed
    aiMenu.current = showAiMenu
    placeAsked.current = initialPlace
    placeReport.current = onPlace
    countsReport.current = onCounts
    caretLineReport.current = onCaretLine
    focusOnOpen.current = autoFocus
    focusOnlyIfFree.current = autoFocusIfFree
    report.current = onText
    loaded.current = onLoaded
    linkSources.current = links
    findHandle.current = onFind
    scrollHandle.current = onScrollPane
    fromSelection.current = onNewFromSelection
    fromLink.current = onNewFromLink
    imagesRefused.current = onImagesRefused
    openFailed.current = onOpenFailed
    editRefused.current = onEditRefused
    noteOpener.current = onOpenNote
    loading.current = onLoading
    preopened.current = takePreopened
    alertMenu.current = showAlertMenu
    latestSettings.current = settings
    imageHandlers.current = { open: onOpenImage, menu: showImageMenu }
  })

  useEffect(
    () =>
      subscribeKeymap(() => editor.current?.view.dispatch({ effects: reconfigureRegistryKeys() })),
    [],
  )

  // An imported font face that has loaded changes the text's size: measure again.
  useEffect(() => subscribeFontsLoaded(() => editor.current?.view.requestMeasure()), [])

  const counting = onCounts !== undefined
  useEffect(() => {
    if (counting) editor.current?.view.dispatch({ effects: recount.of(null) })
  }, [counting])

  useEffect(() => {
    if (templateShown.current === templateOffered) return
    templateShown.current = templateOffered
    editor.current?.view.dispatch({
      effects: templateSlot.reconfigure(templateChip(templateOffered, chooseTemplateRef)),
    })
  }, [templateOffered])

  useEffect(() => {
    const view = editor.current?.view
    if (writing.current === write) return
    writing.current = write
    if (!view) return
    // The line at the top stays there: hidden marks and a folded front matter change line heights above it.
    const scroller = box.current?.scroller
    const top = scroller && !hidden ? editorTop(view, scroller) : undefined
    view.dispatch({ effects: writeSlot.reconfigure(writeFor(write, core)) })
    if (scroller && top) scrollToTop(view, scroller, top)
  }, [write, core, hidden])

  useEffect(() => {
    if (locked.current === readOnly) return
    locked.current = readOnly
    editor.current?.view.dispatch({ effects: lockedSlot.reconfigure(readOnly ? LOCKED : []) })
  }, [readOnly])

  useEffect(() => {
    const now = editor.current
    const s = shown.current
    if (!now || !s || now.settings.authorship === settings.authorship) return
    now.view.dispatch({
      effects: authorshipSlot.reconfigure(marksFor(settings.authorship, s.doc, s.noteId)),
    })
  }, [settings])

  useEffect(() => {
    const now = editor.current
    if (!now || now.settings === settings) return
    const effects = reconfigureSetup(now.settings, settings)
    // The note or code font, its size or the line height change the line heights.
    const remeasure = (
      [
        ...Object.values(FONT_SLOTS.note),
        ...Object.values(FONT_SLOTS.code),
        'fontSize',
        'lineHeight',
      ] as const
    ).some((key) => now.settings[key] !== settings[key])
    now.settings = settings
    if (effects.length > 0) now.view.dispatch({ effects })
    // A setting outside the editor (the sidebar material) leaves it alone.
    if (effects.length > 0 || remeasure) now.view.requestMeasure()
  }, [settings])

  // Shown again after preview mode: a hidden box can lose its scroll position, and a place restored while hidden is not applied yet.
  useEffect(() => {
    const view = editor.current?.view
    const top = shown.current?.place.top
    const scroller = box.current?.scroller
    if (hidden || !view || !top || !scroller) return
    scrollToTop(view, scroller, top)
  }, [hidden])

  // Keys kept for a note whose switch was called off before its body showed: the note shown next takes them.
  const carriedKeys = useRef<EarlyKeysTicket | undefined>(undefined)
  const mounted = useRef(false)
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      // StrictMode mounts again at once; the note stays shown for it.
      queueMicrotask(() => {
        if (mounted.current) return
        carriedKeys.current?.fail()
        carriedKeys.current = undefined
        const view = editor.current?.view
        if (view) shown.current?.close(view.state)
        shown.current = null
        view?.destroy()
        editor.current = null
        box.current = null
        report.current('')
      })
    }
  }, [])

  useLayoutEffect(() => {
    let cancelled = false
    let held = false
    let keys = carriedKeys.current
    carriedKeys.current = undefined
    keys?.claim(noteId)
    const unpublish = () => {
      if (restoreRef) restoreRef.current = null
      if (handleRef) handleRef.current = null
      findHandle.current?.(null)
      scrollHandle.current?.(null)
    }
    const publish = (s: Shown) => {
      const view = editor.current?.view
      const scroller = box.current?.scroller
      if (!view || !scroller) return
      if (restoreRef) restoreRef.current = s.applyStep
      if (handleRef) handleRef.current = s.handle
      findHandle.current?.(editorFindTarget(view))
      scrollHandle.current?.(editorScrollPane(view, scroller))
    }

    const show = (state: Uint8Array, handedOver = false) => {
      const el = host.current
      if (!el) {
        void core.unhold(noteId)
        return
      }
      const { root, frame, scroller, parent } = (box.current ??= shadowContainer(el))
      const doc = new Y.Doc()
      const refused = refusedEdits(noteId, (id, code) => editRefused.current?.(id, code))
      const forward = (update: Uint8Array, origin: unknown) => {
        if (origin !== REMOTE && origin !== RESTORE) core.applyUpdate(noteId, update).catch(refused)
      }
      Y.applyUpdate(doc, state, REMOTE)
      doc.on('update', forward)
      const text = doc.getText(BODY)
      const reportText = () => report.current(text.toString())
      text.observe(reportText)
      // True while a restored version is applied: an undo step of its own,
      // where every other change from the Yjs document is none (editor/undo.ts).
      let restoring = false
      let writesBefore: readonly AgentWrite[] = []
      const applyStep: ApplyRestore = (update) => {
        restoring = true
        writesBefore = readWrites(doc, noteId)
        try {
          Y.applyUpdate(doc, update, RESTORE)
        } finally {
          restoring = false
          writesBefore = []
        }
      }
      const setupFor = latestSettings.current
      const images = attachImages(core, noteId, text, (codes) => imagesRefused.current?.(codes))
      const imageChooser = images.choose
      const body = text.toString()
      const restored = placeAsked.current?.()
      const selection = restored?.selection && clampSelection(restored.selection, body.length)
      const place: EditorPlace = {
        selection: selection ?? { anchor: 0, head: 0 },
      }
      // Kept inside the note, as the selection is: the note can be shorter
      // than when it was stored, and edits map the top line through changes.
      if (restored?.top) place.top = clampTop(restored.top, body.length)
      const placeChanged = () => placeReport.current?.(noteId, { ...place })
      const initial = noteState(
        noteId,
        {
          doc: body,
          ...(selection
            ? {
                selection: EditorSelection.single(selection.anchor, selection.head),
              }
            : {}),
          extensions: [
            ONLY_WHILE_FOCUSED,
            editorSetup(setupFor),
            // No keymap acts on the keys an input method composes with.
            imeKeys(),
            editorTheme,
            selectionEdges,
            // Operators in code keep one style each, so code fonts form ligatures.
            noteHighlighting(noteHighlightStyle),
            markdownLineStyles,
            writeFocusTracking,
            writeSlot.of(writeFor(writing.current, core)),
            noteMarkdown,
            EditorView.perLineTextDirection.of(true),
            images.extension,
            pasteUrls,
            pasteChooser(linkFetcher),
            pastePlainKeys(),
            pasteUrlAsKeys(),
            newFromSelectionKeys(),
            editorMenu((target, at, pos) => menuOpener.current(target, at, pos)),
            newFromLinkKeys(),
            lineCommands((href) => {
              const note = /^devot:\/\/note\/([0-9a-f-]{36})$/.exec(href)
              if (note?.[1]) noteOpener.current?.(note[1])
              else if (/^https:\/\//i.test(href)) {
                invoke('open_external', { url: href }).catch(() =>
                  console.warn('W_OPEN_EXTERNAL_FAILED'),
                )
              }
            }),
            insertKeymap(),
            imageCommandKeys(),
            newFromSelection.of(() => {
              const run = fromSelection.current
              run?.()
              return run !== undefined
            }),
            newFromLink.of(() => {
              const run = fromLink.current
              run?.()
              return run !== undefined
            }),
            trackExtract,
            linkCompletion({
              find: (query) => linkSources.current.find(query),
              create: (title) => linkSources.current.create(title),
              discard: (id) => linkSources.current.discard(id),
              preview: (id) => previewsFor(core)(id),
              linked: (id) => linkSources.current.linked(id),
            }),
            editorCompletions({ chooseImageFiles: (target) => imageChooser(target) }),
            templateSlot.of(templateChip(templateShown.current, chooseTemplateRef)),
            ghostText({
              suggest: (context, trigger) =>
                suggestions.current?.suggest(noteId, context, trigger) ??
                (trigger === 'key'
                  ? Promise.reject(new Error('E_AI_ACCESS_DENIED'))
                  : Promise.resolve(null)),
              cancel: () => suggestions.current?.cancel(),
              failed: (code) => suggestFailed.current?.(code),
            }),
            formatToolbar(
              (...args) => alertMenu.current(...args),
              (view, anchor) => (aiEdit.current ? aiMenu.current(view, anchor) : Promise.resolve()),
            ),
            imageSizeBar,
            tableToolbar,
            linkTooltip,
            noteLinkHover(previewsFor(core)),
            formatKeyAvailability(setInertFormats),
            tableKeymap(),
            tableTyping(),
            // After table typing, whose rules come first in a table.
            overwrite(),
            editorFind(),
            imageActions.of({
              open: (image) => imageHandlers.current.open?.(image),
              menu: (image, at) => imageHandlers.current.menu?.(imageMenuTarget(image), at),
            }),
            popupSpace(frame),
            pausedSlot.of([]),
            lockedSlot.of(locked.current ? LOCKED : []),
            authorshipSlot.of(marksFor(setupFor.authorship, doc, noteId)),
            // Undo is CodeMirror's history alone: no Yjs undo manager.
            authorshipUndo(doc),
            yCollab(text, null, { undoManager: false }),
            yjsHistory(
              () => restoring,
              () => undoneWrites(writesBefore, doc),
            ),
            EditorView.contentAttributes.of({
              'aria-label': t('note.bodyLabel'),
            }),
            editorLayoutWatch,
            countsReporter(
              (counts) => countsReport.current?.(counts),
              () => countsReport.current !== undefined,
            ),
            EditorView.updateListener.of((update) => {
              if (!update.selectionSet && !update.docChanged) return
              if (update.docChanged && place.top) {
                place.top = {
                  ...place.top,
                  pos: update.changes.mapPos(place.top.pos),
                }
              }
              const { anchor, head } = update.state.selection.main
              place.selection = { anchor, head }
              placeChanged()
              caretLineReport.current?.(update.state.doc.lineAt(head).number)
            }),
            EditorView.domEventHandlers({
              scroll: (_event, scrolled) => {
                const top = editorTop(scrolled, scroller)
                if (!top) return
                place.top = top
                placeChanged()
              },
            }),
          ],
        },
        doc,
      )
      // With no scroll position, the selection shows in the middle.
      const scrollTo =
        selection && !restored?.top
          ? EditorView.scrollIntoView(selection.head, { y: 'center' })
          : undefined
      const before = editor.current
      const left = shown.current
      let view: EditorView
      if (before) {
        view = before.view
        const leftState = view.state
        scroller.scrollTop = 0
        view.setState(initial)
        // setState keeps the DOM focus but sends no focus change, so the new state is told.
        const effects = [
          ...(scrollTo ? [scrollTo] : []),
          setToolbarFocus.of(view.hasFocus),
          setWriteFocus.of(view.hasFocus),
        ]
        view.dispatch({ effects })
        before.settings = setupFor
        left?.close(leftState)
      } else {
        view = new EditorView({ root, state: initial, ...(scrollTo ? { scrollTo } : {}), parent })
        editor.current = { view, settings: setupFor }
      }
      const untrackEditor = trackOpenEditor(noteId, view, doc, text)
      caretLineReport.current?.(view.state.doc.lineAt(view.state.selection.main.head).number)
      const ready = view
      const s: Shown = {
        core,
        noteId,
        doc,
        place,
        applyStep,
        close: (leftWith) => {
          keepUndo(noteId, leftWith, doc)
          untrackEditor()
          text.unobserve(reportText)
          doc.off('update', forward)
          doc.destroy()
          void core.unhold(noteId)
        },
        handle: editorHandle(ready, doc, noteId, applyStep, () => shown.current === s),
      }
      shown.current = s
      loaded.current?.(text.toString())
      reportText()
      publish(s)
      // Opened before this editor was published: changes sent in between reached no editor.
      if (handedOver) {
        void catchUp(
          doc,
          (known) => core.open(noteId, known),
          () => shown.current === s,
          REMOTE,
        )
      }
      const settle = () => {
        if (shown.current !== s) return
        takeKeyboard(view, el)
        if (place.top && scroller.clientHeight > 0) scrollToTop(view, scroller, place.top)
      }
      // Focus and typing taken in the commit's layout effects are lost: the caret goes back to the start.
      queueMicrotask(settle)
    }

    // The body took a while to load: a title or palette field the user
    // went to meanwhile keeps the keyboard.
    const takeKeyboard = (view: EditorView, el: HTMLElement) => {
      const take = focusOnlyIfFree.current
        ? keyboardIsFree()
        : !typingElsewhere(document.activeElement, el)
      if ((focusOnOpen.current || keys !== undefined) && take && !earlyKeysKeptForAnother(noteId)) {
        view.focus()
      }
      const typed = takeEarlyKeys(noteId)
      if (typed.length) replayEarlyKeys(view, typed)
    }

    const given = preopened.current?.(core, noteId)
    const now = shown.current
    if (now?.noteId === noteId && now.core === core) {
      // Already shown and held: the window's hold is one too many.
      if (given) void core.unhold(noteId)
      const view = editor.current?.view
      view?.dispatch({ effects: pausedSlot.reconfigure([]) })
      publish(now)
      // Back to the note still on screen: it takes the keyboard the switch took away.
      const el = host.current
      if (view && el && keys) {
        queueMicrotask(() => {
          if (shown.current === now) takeKeyboard(view, el)
        })
      }
    } else if (given) {
      show(given, true)
    } else {
      held = true
      loading.current?.(true)
      const leaving = editor.current?.view
      if (leaving) {
        // Keys typed into the note being left are kept for this one instead.
        if (!keys && leaving.hasFocus) {
          leaving.contentDOM.blur()
          keys = startEarlyKeys()
          keys.claim(noteId)
        }
        leaving.dispatch({ effects: pausedSlot.reconfigure(PAUSED) })
      }
      // The core keeps the note in memory while the editor shows it, so its
      // replica and the core's document never part (see NoteService.hold).
      void core.hold(noteId)
      void core.open(noteId).then(
        (opened) => {
          if (cancelled) return
          held = false
          show(opened.state)
          // In the frame that shows the note, or it would show faded first.
          flushSync(() => loading.current?.(false))
        },
        (e: unknown) => {
          if (cancelled) return
          keys?.fail()
          keys = undefined
          loading.current?.(false)
          openFailed.current?.(noteId, errorCode(e))
        },
      )
    }

    return () => {
      cancelled = true
      if (held) {
        void core.unhold(noteId)
        loading.current?.(false)
        carriedKeys.current = keys
      }
      unpublish()
    }
  }, [core, noteId, restoreRef, handleRef])

  return <div className="editor" data-devot-part="editor-body" ref={host} hidden={hidden} />
}
