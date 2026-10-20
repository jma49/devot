import { isolateHistory } from '@codemirror/commands'
import { EditorSelection } from '@codemirror/state'
import { Facet, Prec, type Extension } from '@codemirror/state'
import { EditorView, keymap, tooltips } from '@codemirror/view'
import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { yCollab } from 'y-codemirror.next'
import * as Y from 'yjs'
import type { ImageSize } from '../../core/images'
import { BODY } from '../../core/notes'
import { imageFiles, storeImages } from './attachments'
import { DRAG_BOOK, DRAG_NOTE } from './dragData'
import { errorCode } from '../../core/errors'
import { anchorAt, insertAtAnchor, trackOpenEditor } from './editor/anchoredInsert'
import { BOX_HANG } from './editor/boxes'
import { readClipboardText } from './clipboard'
import { editorCommandKeys, type CommandId } from './commands/registry'
import { invoke } from './ipc'
import {
  linkOpener,
  lineCommands,
  linkForNewNote,
  runEditCommand,
  type LinkAt,
} from './editor/lineCommands'
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
import { moveRange, moveSelection, selectedText, trackExtract } from './editor/extract'
import { editorFind, editorFindTarget } from './editor/find'
import { formatCommand, type FormatId } from './editor/formats'
import { formatToolbar } from './editor/FormatToolbar'
import { noteHighlighting } from './editor/highlighting'
import { systemMenus, systemMenusAvailable } from './editor/systemMenu'
import { imageSizeBar } from './editor/ImageSizeBar'
import { tableToolbar } from './editor/TableToolbar'
import { linkTooltip } from './editor/linkTooltip'
import { noteLinkHover } from './editor/noteLinkHover'
import { previewsFor } from './notePreview'
import { formatKeyAvailability } from './editor/formatKeys'
import { imeKeys } from './editor/imeKeys'
import { earlyKeysKeptForAnother, replayEarlyKeys, takeEarlyKeys } from './editor/earlyKeys'
import { editorScrollPane } from './editor/scrollPane'
import { insertCommand, insertKeymap, type InsertId } from './editor/insert'
import { imageActions, imageAt, imageSizeChange, viewImageAt } from './editor/images'
import { TABLE_COMMANDS, inTable, tableKeymap, type TableCommandId } from './editor/tableCommands'
import { tableTyping } from './editor/tableTyping'
import { markdownLineStyles } from './editor/lineStyles'
import { noteHighlightStyle, noteMarkdown } from './editor/markdown'
import { pasteUrlAs, pasteUrls, plainPaste } from './editor/paste'
import { pasteChooser, showChooser, type PasteFetcher } from './editor/pasteChooser'
import { editorSetup, reconfigureSetup } from './editor/settings'
import { editorCompletions } from './editor/completions'
import { taskToggle } from './editor/tasks'
import { keepUndo, noteState, yjsHistory } from './editor/undo'
import { reconfigureRegistryKeys, registryKeys } from './editor/registryKeys'
import { setInertFormats } from './commands/formatMenu'
import { subscribeKeymap } from './commands/shortcutSettings'
import { FONT_SLOTS } from '../../core/editorSettings'
import { subscribeFontsLoaded } from './fonts'
import { useEditorSettings } from './editorSettings'
import type { FindTarget } from './find/target'
import { keyboardIsFree, typingElsewhere } from './focus'
import { t } from './i18n'
import {
  imageActionApplies,
  imageKeys,
  imageMenuTarget,
  runImageAction,
  type ImageMenuTarget,
  type ImageSource,
  type ShowImageMenu,
} from './imageMenu'
import type { ViewedImage } from './ImageViewer'
import { linkCompletion, type LinkSources } from './linkCompletion'
import type { Core } from './core-client'
import type { ScrollPane } from './preview/scrollSync'
import { clampSelection, clampTop, type EditorTop, type SelectionState } from './lastState'

const REMOTE = 'remote'
/** A restored version: the core made it, and undo takes it back (editor/undo.ts). */
const RESTORE = 'restore'

export type ApplyRestore = (update: Uint8Array) => void

export interface EditorPlace {
  selection: SelectionState
  top?: EditorTop
}

export interface EditorHandle {
  noteId: string
  /** The replica's state vector, so the core sends only what it lacks (NoteService.open). */
  vector: () => Uint8Array
  /** Takes in the core's state after it merged another process's writes: shown outside the undo history, not sent back. */
  takeState: (state: Uint8Array) => void
  /** Like `takeState`, for a change the user asked for (a template filling the note): one undo step, not sent back. */
  takeStep: (state: Uint8Array) => void
  focus: () => void
  focusStart: () => void
  remeasure: () => void
  format: (id: FormatId) => void
  insert: (id: InsertId) => void
  text: () => string
  /** Caret to the start of line `line` (1-based), scrolled to the view's top (outline entry) or middle (Go to Line). */
  goToLine: (line: number, where?: 'start' | 'center') => void
  inTable: () => boolean
  table: (id: TableCommandId) => void
  hasSelection: () => boolean
  /** Hands the selected text to `make` and puts the text it resolves to (a note link) in its place, as one undo step (editor/extract.ts). */
  moveSelection: (make: (text: string) => Promise<string | null>) => Promise<boolean>
  linkAtCursor: () => LinkAt | null
  /** Like `moveSelection`, for a range. */
  moveRange: (
    from: number,
    to: number,
    make: (text: string) => Promise<string | null>,
  ) => Promise<boolean>
  pastePlain: () => Promise<void>
  runLine: (id: CommandId) => void
  pasteUrlAs: () => Promise<void>
  imageAtCursor: () => ImageMenuTarget | null
  /** Shows that image in the viewer (an attachment only); false when there is none. */
  viewImage: () => boolean
  /** Gives the image at `source` a size as one change; false when that text is no longer that image. */
  setImageSize: (source: ImageSource, size: ImageSize) => boolean
  /** Ticks or unticks the task whose mark is at `at` as one change; false when no box is there any more. */
  toggleTask: (at: number) => boolean
}

async function pastePlain(view: EditorView): Promise<void> {
  const text = await readClipboardText().catch(() => {
    console.warn('W_CLIPBOARD_READ_FAILED')
    return ''
  })
  const spec = plainPaste(view.state, text)
  if (spec) view.dispatch(spec)
}

async function pasteUrlAsIn(view: EditorView): Promise<void> {
  const text = await readClipboardText().catch(() => {
    console.warn('W_CLIPBOARD_READ_FAILED')
    return ''
  })
  const spec = pasteUrlAs(view.state, text)
  if (!spec) return
  view.dispatch(spec)
  showChooser(view)
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

const pasteUrlAsKeys = registryKeys(() =>
  keymap.of(
    editorCommandKeys('edit.pasteUrlAs').map((key) => ({
      key,
      run: (view: EditorView) => {
        void pasteUrlAsIn(view)
        return true
      },
      preventDefault: true,
    })),
  ),
)

/** Paste as Plain Text keys, ahead of CodeMirror's own bindings such as format and find. */
const pastePlainKeys = registryKeys(() =>
  Prec.high(
    keymap.of(
      editorCommandKeys('edit.pastePlain').map((key) => ({
        key,
        run: (view: EditorView) => {
          void pastePlain(view)
          return true
        },
        preventDefault: true,
      })),
    ),
  ),
)

/** What New Note from Selection does here (the window makes the note); false when it cannot. */
const newFromSelection = Facet.define<() => boolean, (() => boolean) | undefined>({
  combine: (all) => all[0],
})

/** With text selected the keys hand it to the window; with none they do nothing. */
const newFromSelectionKeys = registryKeys(() =>
  Prec.high(
    keymap.of(
      editorCommandKeys('note.newFromSelection').map((key) => ({
        key,
        run: (view: EditorView) =>
          selectedText(view.state) !== null && (view.state.facet(newFromSelection)?.() ?? false),
        preventDefault: true,
      })),
    ),
  ),
)

const newFromLink = Facet.define<() => boolean, (() => boolean) | undefined>({
  combine: (all) => all[0],
})

const newFromLinkKeys = registryKeys(() =>
  Prec.high(
    keymap.of(
      editorCommandKeys('note.newFromLink').map((key) => ({
        key,
        run: (view: EditorView) =>
          linkForNewNote(view.state, view.state.selection.main.head) !== undefined &&
          (view.state.facet(newFromLink)?.() ?? false),
        preventDefault: true,
      })),
    ),
  ),
)

function setImageSize(view: EditorView, source: ImageSource, size: ImageSize): boolean {
  const change = imageSizeChange(view.state, source, size)
  if (!change) {
    console.warn('W_IMAGE_SIZE_STALE')
    return false
  }
  view.dispatch(change)
  return true
}

/** Image command keys (none by default): they do nothing when there is no image or the command does not apply. */
const imageCommandKeys = registryKeys(() =>
  Prec.high(
    keymap.of([
      ...imageKeys().map(({ action, key }) => ({
        key,
        run: (view: EditorView) => {
          const image = imageAt(view.state, view.state.selection.main.head)
          const target = image && imageMenuTarget(image)
          if (!target || !imageActionApplies(action, target)) return false
          void runImageAction(action, target, (source, size) => setImageSize(view, source, size))
          return true
        },
        preventDefault: true,
      })),
      ...editorCommandKeys('image.view').map((key) => ({
        key,
        run: viewImageAt,
        preventDefault: true,
      })),
    ]),
  ),
)

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

/**
 * The editor lives in a shadow root: CodeMirror adds its styles there as constructed stylesheets, which the production CSP allows (in the document it would add <style> tags, which the CSP blocks). Theme variables inherit into it.
 */
const theme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'transparent',
    color: 'var(--color-text-editor)',
  },
  '.cm-scroller': {
    fontSize: 'var(--editor-font-size, var(--font-size-body))',
    fontFamily: 'var(--editor-font-family, var(--font-family-mono))',
    fontWeight: 'var(--editor-font-weight, normal)',
    lineHeight: 'var(--editor-line-height, 1.5)',
  },
  '&.cm-focused': { outline: 'none' },
  // Room for the boxes and quote bars that reach past the lines (editor/boxes.ts).
  '.cm-content': {
    paddingInline: BOX_HANG,
    fontKerning: 'normal',
    lineBreak: 'strict',
  },
  '@supports (text-autospace: normal)': {
    '.cm-content': { textAutospace: 'normal' },
    '.cm-line.cm-codeblock, .cm-md-code': { textAutospace: 'no-autospace' },
  },
  '.cm-scroller::-webkit-scrollbar': {
    width: 'var(--size-scrollbar)',
    height: 'var(--size-scrollbar)',
    background: 'transparent',
  },
  '.cm-scroller::-webkit-scrollbar-thumb': {
    borderRadius: 'var(--radius-capsule)',
    background: 'var(--color-fill-scrollbar)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--color-editor-caret)',
    borderLeftWidth: 'var(--space-1)',
  },
  '.cm-placeholder': { color: 'var(--color-editor-placeholder)' },
  // CodeMirror's own colours are for a light page; these follow the tokens,
  // so the gutter, the active line and the selection read in both appearances.
  // The gutter is sticky: it stays opaque so unwrapped text scrolled under it does not show through.
  '.cm-gutters': {
    backgroundColor: 'var(--color-surface-editor)',
    color: 'var(--color-text-tertiary)',
    border: '0',
  },
  '.cm-activeLine': { backgroundColor: 'var(--color-editor-active-line)' },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--color-editor-active-line)',
    color: 'var(--color-text-primary)',
  },
  // The selection is drawn in a layer behind the lines, so the active line's tint lies over it.
  // A solid tint that stands 1.3:1 from both; lighter while the editor does not have focus.
  '.cm-selectionBackground': { backgroundColor: 'var(--color-accent-selection-inactive)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--color-accent-selection)',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--color-fill-match)' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--color-fill-track)',
    color: 'var(--color-text-secondary)',
    border: '0',
  },
  '.cm-tooltip': {
    border: '0',
    borderRadius: 'var(--radius-card)',
    backgroundColor: 'var(--color-surface-editor)',
    boxShadow: '0 0 0 0.5px var(--color-line-hairline)',
    color: 'var(--color-text-primary)',
  },
})

/**
 * Popups live in the frame around the scroll box so scrolling does not clip them: one over the first lines may reach up over the title and meta line, and a popup with no room above a line opens below it. A further box that clips (the split view's sideways scroll) holds them in too.
 */
const popupSpace = (frame: HTMLElement) =>
  tooltips({
    parent: frame,
    tooltipSpace: (view) => {
      const root = view.dom.getRootNode()
      const host = root instanceof ShadowRoot ? (root.host as HTMLElement) : view.dom
      const box = host.getBoundingClientRect()
      const pane = host.closest('[data-devot-part="editor"]')
      const toolbar = pane?.querySelector('[data-devot-part="toolbar"]')
      if (!pane || !toolbar) return box
      let top = toolbar.getBoundingClientRect().bottom
      for (let el = host.parentElement; el && el !== pane; el = el.parentElement) {
        if (getComputedStyle(el).overflowY !== 'visible') {
          top = Math.max(top, el.getBoundingClientRect().top)
        }
      }
      return { left: box.left, right: box.right, top: Math.min(top, box.top), bottom: box.bottom }
    },
  })

/** The editor's own styles in its shadow root, where the window's stylesheet does not reach. */
const frameStyles = (() => {
  let sheet: CSSStyleSheet | undefined
  return () => {
    if (!sheet) {
      sheet = new CSSStyleSheet()
      sheet.replaceSync(`
        /* Grid stretching, not percentages: the scroll box is as tall as
           the host when the window's layout gives it a height. */
        :host,
        .editor-frame { display: grid; min-height: 0; }
        .editor-frame { position: relative; }
        .editor-scroll { min-height: 0; }
        /* The lines slide inside it with the panes (paneMotion.ts) without
           ever making the box scroll sideways. */
        .editor-root { overflow-x: clip; }
        /* CodeMirror's popup layer covers the editor: only the popups in it
           take the pointer. */
        .editor-frame { pointer-events: none; }
        .editor-scroll,
        .editor-frame .cm-tooltip { pointer-events: auto; }
        .editor-scroll {
          box-sizing: border-box;
          overflow: auto;
          padding: var(--editor-padding);
        }
        .editor-scroll::-webkit-scrollbar {
          width: var(--size-scrollbar);
          height: var(--size-scrollbar);
          background: transparent;
        }
        .editor-scroll::-webkit-scrollbar-thumb {
          border-radius: var(--radius-capsule);
          background: var(--color-fill-scrollbar);
        }
      `)
    }
    return sheet
  }
})()

function shadowContainer(host: HTMLElement): {
  root: ShadowRoot
  frame: HTMLElement
  scroller: HTMLElement
  parent: HTMLElement
} {
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
  root.replaceChildren()
  if (!root.adoptedStyleSheets.includes(frameStyles())) {
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, frameStyles()]
  }
  const frame = document.createElement('div')
  frame.className = 'editor-frame'
  const scroller = document.createElement('div')
  scroller.className = 'editor-scroll'
  scroller.dataset['devotPart'] = 'editor-scroll'
  const parent = document.createElement('div')
  parent.className = 'editor-root'
  scroller.appendChild(parent)
  frame.appendChild(scroller)
  root.appendChild(frame)
  return { root, frame, scroller, parent }
}

interface Props {
  core: Core
  noteId: string
  /** Focus the body once it loads (a note just created, or Cmd+Return on its row). */
  autoFocus: boolean
  /** With `autoFocus`: only if nothing has the keyboard when the body has loaded (a restore). */
  autoFocusIfFree?: boolean
  /** Kept mounted but out of sight in preview mode, so the text stays live. */
  hidden: boolean
  onText: (text: string) => void
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
  onNewFromSelection?: (() => void) | undefined
  onNewFromLink?: (() => void) | undefined
  onImagesRefused?: (codes: string[]) => void
  onOpenFailed?: (noteId: string, code: string) => void
  onChooseTemplate?: () => void
  onOpenNote?: (noteId: string) => void
}

export function NoteEditor({
  core,
  noteId,
  autoFocus,
  autoFocusIfFree = false,
  hidden,
  onText,
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
  onNewFromSelection,
  onNewFromLink,
  onImagesRefused,
  onOpenFailed,
  onChooseTemplate,
  onOpenNote,
}: Props) {
  const host = useRef<HTMLDivElement>(null)
  // Read once, when the note has loaded.
  const focusOnOpen = useRef(autoFocus)
  const focusOnlyIfFree = useRef(autoFocusIfFree)
  const settings = useEditorSettings()
  const latestSettings = useRef(settings)
  const open = useRef<{
    view: EditorView
    settings: typeof settings
    scroller: HTMLElement
    place: EditorPlace
  } | null>(null)
  const report = useRef(onText)
  const linkSources = useRef(links)
  const findHandle = useRef(onFind)
  const scrollHandle = useRef(onScrollPane)
  const imageHandlers = useRef({ open: onOpenImage, menu: showImageMenu })
  const placeAsked = useRef(initialPlace)
  const placeReport = useRef(onPlace)
  const fromSelection = useRef(onNewFromSelection)
  const fromLink = useRef(onNewFromLink)
  const imagesRefused = useRef(onImagesRefused)
  const openFailed = useRef(onOpenFailed)
  const chooseTemplateRef = useRef(onChooseTemplate)
  const noteOpener = useRef(onOpenNote)
  const menuAt = useRef<MenuPoint>({ x: 0, y: 0 })
  const pickMenuAction = useCallback((action: EditorAction, target: EditorMenuTarget) => {
    const view = open.current?.view
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
      // The system's own items act on the web view; the submenu only holds items.
      default:
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
  useEffect(() => {
    menuOpener.current = (view, at, pos) => {
      menuAt.current = at
      const target = editorMenuTarget(view.state, pos, fromSelection.current !== undefined)
      const word = spellingWordAt(view.state, pos)
      menuWord.current = word ? { view, word } : null
      void showEditorMenu(target, at)
    }
    chooseTemplateRef.current = onChooseTemplate
    placeAsked.current = initialPlace
    placeReport.current = onPlace
    focusOnOpen.current = autoFocus
    focusOnlyIfFree.current = autoFocusIfFree
    report.current = onText
    linkSources.current = links
    findHandle.current = onFind
    scrollHandle.current = onScrollPane
    fromSelection.current = onNewFromSelection
    fromLink.current = onNewFromLink
    imagesRefused.current = onImagesRefused
    openFailed.current = onOpenFailed
    noteOpener.current = onOpenNote
    latestSettings.current = settings
    imageHandlers.current = { open: onOpenImage, menu: showImageMenu }
  })

  useEffect(
    () =>
      subscribeKeymap(() => open.current?.view.dispatch({ effects: reconfigureRegistryKeys() })),
    [],
  )

  // An imported font face that has loaded changes the text's size: measure again.
  useEffect(() => subscribeFontsLoaded(() => open.current?.view.requestMeasure()), [])

  useEffect(() => {
    const now = open.current
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
    const now = open.current
    if (hidden || !now?.place.top) return
    scrollToTop(now.view, now.scroller, now.place.top)
  }, [hidden])

  useEffect(() => {
    let view: EditorView | undefined
    let untrackEditor: (() => void) | undefined
    let cancelled = false
    const doc = new Y.Doc()
    const forward = (update: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE && origin !== RESTORE) void core.applyUpdate(noteId, update)
    }

    // The core keeps the note in memory while the editor shows it, so its
    // replica and the core's document never part (see NoteService.hold).
    void core.hold(noteId)
    void core.open(noteId).then(
      (opened) => {
        if (cancelled || !host.current) return
        Y.applyUpdate(doc, opened.state, REMOTE)
        doc.on('update', forward)
        const text = doc.getText(BODY)
        report.current(text.toString())
        text.observe(() => report.current(text.toString()))
        const { root, frame, scroller, parent } = shadowContainer(host.current)
        // True while a restored version is applied: an undo step of its own,
        // where every other change from the Yjs document is none (editor/undo.ts).
        let restoring = false
        const applyStep: ApplyRestore = (update) => {
          restoring = true
          try {
            Y.applyUpdate(doc, update, RESTORE)
          } finally {
            restoring = false
          }
        }
        if (restoreRef) restoreRef.current = applyStep
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
              editorSetup(setupFor),
              // No keymap acts on the keys an input method composes with.
              imeKeys(),
              theme,
              // Operators in code keep one style each, so code fonts form ligatures.
              noteHighlighting(noteHighlightStyle),
              markdownLineStyles,
              noteMarkdown,
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
              editorCompletions({
                chooseImageFiles: (target) => imageChooser(target),
                chooseTemplate: () => chooseTemplateRef.current?.(),
              }),
              formatToolbar(showAlertMenu),
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
              // Undo is CodeMirror's history alone: no Yjs undo manager.
              yCollab(text, null, { undoManager: false }),
              yjsHistory(() => restoring),
              EditorView.contentAttributes.of({
                'aria-label': t('note.bodyLabel'),
              }),
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
        view = new EditorView({
          root,
          state: initial,
          // With no scroll position, the selection shows in the middle.
          ...(selection && !restored?.top
            ? {
                scrollTo: EditorView.scrollIntoView(selection.head, {
                  y: 'center',
                }),
              }
            : {}),
          parent,
        })
        open.current = { view, settings: setupFor, scroller, place }
        untrackEditor = trackOpenEditor(noteId, view, doc, text)
        findHandle.current?.(editorFindTarget(view))
        scrollHandle.current?.(editorScrollPane(view, scroller))
        const ready = view
        if (handleRef) {
          handleRef.current = {
            noteId,
            vector: () => Y.encodeStateVector(doc),
            takeState: (state) => Y.applyUpdate(doc, state, REMOTE),
            takeStep: applyStep,
            focus: () => ready.focus(),
            focusStart: () => {
              ready.focus()
              ready.dispatch({ selection: { anchor: 0 }, scrollIntoView: true })
            },
            remeasure: () => ready.requestMeasure(),
            format: (id) => {
              ready.focus()
              formatCommand(id)(ready)
            },
            insert: (id) => {
              ready.focus()
              insertCommand(id)(ready)
            },
            text: () => ready.state.doc.toString(),
            goToLine: (line, where = 'start') => {
              const text = ready.state.doc
              const at = text.line(Math.min(text.lines, Math.max(1, Math.floor(line)))).from
              ready.focus()
              ready.dispatch({
                selection: EditorSelection.cursor(at),
                effects: EditorView.scrollIntoView(
                  at,
                  where === 'center' ? { y: 'center' } : { y: 'start', yMargin: 24 },
                ),
              })
            },
            inTable: () => inTable(ready.state),
            table: (id) => {
              ready.focus()
              const tr = TABLE_COMMANDS[id](ready.state)
              if (tr) ready.dispatch(tr)
            },
            hasSelection: () => selectedText(ready.state) !== null,
            moveSelection: (make) => moveSelection(ready, make, () => !cancelled),
            linkAtCursor: () =>
              linkForNewNote(ready.state, ready.state.selection.main.head) ?? null,
            moveRange: (from, to, make) => moveRange(ready, from, to, make, () => !cancelled),
            pastePlain: () => {
              ready.focus()
              return pastePlain(ready)
            },
            runLine: (id) => {
              ready.focus()
              runEditCommand(ready, id)
            },
            pasteUrlAs: () => {
              ready.focus()
              return pasteUrlAsIn(ready)
            },
            imageAtCursor: () => {
              const image = imageAt(ready.state, ready.state.selection.main.head)
              return image ? imageMenuTarget(image) : null
            },
            viewImage: () => viewImageAt(ready),
            setImageSize: (source, size) => setImageSize(ready, source, size),
            toggleTask: (at) => {
              const change = taskToggle(ready.state, at)
              if (change) ready.dispatch(change)
              return change !== null
            },
          }
        }
        // The body took a while to load: a title or palette field the user
        // went to meanwhile keeps the keyboard.
        const take = focusOnlyIfFree.current
          ? keyboardIsFree()
          : !typingElsewhere(document.activeElement, host.current)
        if (focusOnOpen.current && take && !earlyKeysKeptForAnother(noteId)) view.focus()
        const typed = takeEarlyKeys(noteId)
        if (typed.length) replayEarlyKeys(view, typed)
        if (place.top && scroller.clientHeight > 0) scrollToTop(view, scroller, place.top)
      },
      (e: unknown) => {
        if (!cancelled) openFailed.current?.(noteId, errorCode(e))
      },
    )

    return () => {
      cancelled = true
      if (restoreRef) restoreRef.current = null
      if (view) {
        keepUndo(noteId, view.state, doc)
        findHandle.current?.(null)
        scrollHandle.current?.(null)
      }
      if (handleRef) handleRef.current = null
      open.current = null
      untrackEditor?.()
      doc.off('update', forward)
      view?.destroy()
      doc.destroy()
      void core.unhold(noteId)
    }
  }, [core, noteId, restoreRef, showAlertMenu, handleRef])

  return <div className="editor" data-devot-part="editor-body" ref={host} hidden={hidden} />
}
