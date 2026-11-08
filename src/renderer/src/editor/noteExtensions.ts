import { Compartment, EditorState, Prec, type Extension, type StateEffect } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { RefObject } from 'react'
import { yCollab, ySyncAnnotation } from 'y-codemirror.next'
import type * as Y from 'yjs'
import type { Suggester } from '../../../core/aiSuggest'
import type { Core } from '../core-client'
import { setInertFormats } from '../commands/formatMenu'
import type { MenuPoint } from '../contextMenu'
import type { useEditorSettings } from '../editorSettings'
import { logFailure } from '../failure'
import { t } from '../i18n'
import { imageMenuTarget, type ShowImageMenu } from '../imageMenu'
import type { ViewedImage } from '../ImageViewer'
import { invoke } from '../ipc'
import type { EditorTop, SelectionState } from '../lastState'
import { linkCompletion, type LinkSources } from '../linkCompletion'
import { previewsFor } from '../notePreview'
import { tallyNote } from '../noteTally'
import { previewLabels } from '../preview/Preview'
import type { ShowAiMenu, StartAiEdit } from './aiMenu'
import type { ShowAlertMenu } from './alertMenu'
import { authorshipMarks } from './authorship'
import { authorshipUndo } from './authorshipUndo'
import { editorCompletions } from './completions'
import { countsReporter, type EditorCounts } from './counts'
import { editorMenu } from './editorMenu'
import { trackExtract } from './extract'
import { editorFind } from './find'
import { formatKeyAvailability } from './formatKeys'
import { formatToolbar } from './FormatToolbar'
import { ghostText } from './ghostText'
import { noteHighlighting } from './highlighting'
import { chooseTemplate } from './hints'
import { imageSizeBar } from './ImageSizeBar'
import { imageActions } from './images'
import { imeKeys } from './imeKeys'
import { insertKeymap } from './insert'
import { lineCommands } from './lineCommands'
import { markdownLineStyles } from './lineStyles'
import { linkTooltip } from './linkTooltip'
import { noteHighlightStyle, noteMarkdown } from './markdown'
import {
  imageCommandKeys,
  newFromLink,
  newFromLinkKeys,
  newFromSelection,
  newFromSelectionKeys,
  pastePlainKeys,
  pasteUrlAsKeys,
} from './noteKeys'
import { noteLinkHover } from './noteLinkHover'
import { overwrite } from './overwrite'
import { parseToView } from './parseToView'
import { pasteUrls } from './paste'
import { pasteChooser, type PasteFetcher } from './pasteChooser'
import { editorLayoutWatch } from './scrollPane'
import { selectionEdges } from './selectionEdges'
import { editorSetup } from './settings'
import { tableKeymap } from './tableCommands'
import { tableToolbar } from './TableToolbar'
import { tableTyping } from './tableTyping'
import { editorTheme, popupSpace } from './theme'
import { yjsHistory } from './undo'
import { tableDrawings, writeFocusTracking, writeMode, type WriteRenderer } from './write'

// The note being left while the next one loads: on screen, but nothing typed may land in it.
export const pausedSlot = new Compartment()
export const PAUSED = [
  EditorView.editable.of(false),
  EditorState.readOnly.of(true),
  // Not offered as the body to type into until the next note is.
  EditorView.contentAttributes.of({ 'aria-hidden': 'true' }),
]
// Notes are read-only once the trial is over without a licence: the text can be read, selected and
// copied, and only what another replica sends (Yjs) still changes it.
export const lockedSlot = new Compartment()
export const LOCKED = [
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
// A read-only contenteditable still takes the caret, and on the iPhone a tap on it raises the keyboard.
const NO_KEYBOARD = [...LOCKED, EditorView.editable.of(false)]

export type EditorLock = 'none' | 'readOnly' | 'noKeyboard'

export const lockExtensions = (lock: EditorLock) =>
  lock === 'none' ? [] : lock === 'readOnly' ? LOCKED : NO_KEYBOARD
// WebKit keeps a contenteditable's selection when focus moves to a sheet or the history bar, and
// runs Backspace and typing against it even under `inert` or a modal: the note out of sight would
// change. The change is dropped and the editor draws its own text again. It comes first among the
// highest-precedence handlers so no other one (close brackets, backticks, table typing, overwrite)
// dispatches the change before the check runs.
const ONLY_WHILE_FOCUSED = Prec.highest(EditorView.inputHandler.of((view) => !view.hasFocus))
// View > Show Authorship (editor/authorship.ts), set for the replica of the note shown.
export const authorshipSlot = new Compartment()
// The empty note's Choose a Template chip: only where the window can run it on a note that may change.
export const templateSlot = new Compartment()
export const templateChip = (
  offered: boolean,
  run: { readonly current: (() => void) | undefined },
) => (offered ? chooseTemplate.of(() => run.current?.()) : [])
// Write mode (editor/write): the editor itself, so the caret, the history and the place are kept.
export const writeSlot = new Compartment()
export const writeFor = (on: boolean, core: Core) =>
  on ? writeMode({ loadNote: previewsFor(core), render: blockRenderer(core) }) : []

/** Write mode's images, formulas and diagrams, by the preview's renderers in the core. */
const blockRenderer = (core: Core): WriteRenderer => ({
  render: (markdown, loadedEmbeds, remoteImages) =>
    core
      .renderPreviewPieces(
        markdown,
        {
          labels: previewLabels(),
          loadedEmbeds: [...loadedEmbeds],
          ...(remoteImages
            ? { remoteImages: { ...remoteImages, loadedHosts: [...remoteImages.loadedHosts] } }
            : {}),
        },
        [],
      )
      .then((pieces) => pieces.flatMap((piece) => piece.nodes ?? [])),
})
export const marksFor = (on: boolean, doc: Y.Doc, noteId: string) =>
  on ? authorshipMarks(doc, noteId) : []

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
export function editorTop(view: EditorView, scroller: HTMLElement): EditorTop | undefined {
  // Hidden (preview mode): it shows nothing, so it keeps the place it had.
  if (scroller.clientHeight === 0) return undefined
  const y = scroller.getBoundingClientRect().top - view.documentTop
  const block = view.lineBlockAtHeight(y)
  return { pos: block.from, offset: y - block.top }
}

/**
 * Scrolls the editor so that `top` is where it was (a line gone since: the end) when CodeMirror next measures.
 * A scroll made before then wins: a busy page can hold that measure until the scroll's own event.
 */
export function scrollToTop(view: EditorView, scroller: HTMLElement, top: EditorTop) {
  const from = scroller.scrollTop
  view.requestMeasure({
    read: (v) => {
      if (scroller.scrollTop !== from) return undefined
      const y = scroller.getBoundingClientRect().top - v.documentTop
      const target = v.lineBlockAt(Math.min(top.pos, v.state.doc.length)).top + top.offset
      return scroller.scrollTop + target - y
    },
    write: (scrollTop) => {
      if (scrollTop !== undefined) scroller.scrollTop = scrollTop
    },
  })
}

/** The editor's props as they are when an extension runs, not when the note was shown. */
export interface NoteEditorRefs {
  writing: RefObject<boolean>
  menuOpener: RefObject<(view: EditorView, at: MenuPoint, pos: number | null) => void>
  noteOpener: RefObject<((noteId: string) => void) | undefined>
  fromSelection: RefObject<(() => void) | undefined>
  fromLink: RefObject<(() => void) | undefined>
  linkSources: RefObject<LinkSources>
  templateShown: RefObject<boolean>
  chooseTemplate: RefObject<(() => void) | undefined>
  suggestions: RefObject<Suggester | undefined>
  suggestFailed: RefObject<((code: string) => void) | undefined>
  alertMenu: RefObject<ShowAlertMenu>
  aiEdit: RefObject<StartAiEdit | undefined>
  aiMenu: RefObject<ShowAiMenu>
  imageHandlers: RefObject<{
    open: ((image: ViewedImage) => void) | undefined
    menu: ShowImageMenu | undefined
  }>
  locked: RefObject<EditorLock>
  countsReport: RefObject<((counts: EditorCounts) => void) | undefined>
  caretLineReport: RefObject<((line: number) => void) | undefined>
}

/** The note an editor state is made for, and where it reports its place. */
export interface ShownNote {
  core: Core
  noteId: string
  doc: Y.Doc
  text: Y.Text
  settings: ReturnType<typeof useEditorSettings>
  frame: HTMLElement
  scroller: HTMLElement
  images: { extension: Extension; choose: (view: EditorView) => void }
  /** Kept up to date as the selection moves, the editor scrolls and edits move the top line. */
  place: EditorPlace
  placeChanged: () => void
  /** True while a restored version is applied (editor/undo.ts). */
  restoring: () => boolean
  /** The agent writes a restore took away, put back by its undo (editor/authorshipUndo.ts). */
  restoredWrites: () => readonly StateEffect<unknown>[]
}

/** Every extension of a note's editor state, in precedence order. */
export function noteExtensions(note: ShownNote, refs: NoteEditorRefs): Extension[] {
  const { core, noteId, doc, text, settings, frame, scroller, images, place, placeChanged } = note
  const imageChooser = images.choose
  return [
    ONLY_WHILE_FOCUSED,
    editorSetup(settings),
    // No keymap acts on the keys an input method composes with.
    imeKeys(),
    editorTheme,
    selectionEdges,
    // Operators in code keep one style each, so code fonts form ligatures.
    noteHighlighting(noteHighlightStyle),
    markdownLineStyles,
    writeFocusTracking,
    // Outside the slot, so the note's tables are not drawn again each time Write mode comes back.
    tableDrawings,
    writeSlot.of(writeFor(refs.writing.current, core)),
    noteMarkdown,
    parseToView,
    EditorView.perLineTextDirection.of(true),
    images.extension,
    pasteUrls,
    pasteChooser(linkFetcher),
    pastePlainKeys(),
    pasteUrlAsKeys(),
    newFromSelectionKeys(),
    editorMenu((target, at, pos) => refs.menuOpener.current(target, at, pos)),
    newFromLinkKeys(),
    lineCommands((href) => {
      const linked = /^devot:\/\/note\/([0-9a-f-]{36})$/.exec(href)
      if (linked?.[1]) refs.noteOpener.current?.(linked[1])
      else if (/^https:\/\//i.test(href)) {
        invoke('open_external', { url: href }).catch(() => console.warn('W_OPEN_EXTERNAL_FAILED'))
      }
    }),
    insertKeymap(),
    imageCommandKeys(),
    newFromSelection.of(() => {
      const run = refs.fromSelection.current
      run?.()
      return run !== undefined
    }),
    newFromLink.of(() => {
      const run = refs.fromLink.current
      run?.()
      return run !== undefined
    }),
    trackExtract,
    linkCompletion({
      find: (query) => refs.linkSources.current.find(query),
      create: (title) => refs.linkSources.current.create(title),
      discard: (id) => refs.linkSources.current.discard(id),
      preview: (id) => previewsFor(core)(id),
      linked: (id) => refs.linkSources.current.linked(id),
    }),
    editorCompletions({ chooseImageFiles: (target) => imageChooser(target) }),
    templateSlot.of(templateChip(refs.templateShown.current, refs.chooseTemplate)),
    ghostText({
      suggest: (context, trigger) =>
        refs.suggestions.current?.suggest(noteId, context, trigger) ??
        (trigger === 'key'
          ? Promise.reject(new Error('E_AI_ACCESS_DENIED'))
          : Promise.resolve(null)),
      cancel: () => refs.suggestions.current?.cancel(),
      failed: (code) => refs.suggestFailed.current?.(logFailure(code, 'W_AI_SUGGEST_FAILED')),
    }),
    formatToolbar(
      (...args) => refs.alertMenu.current(...args),
      (view, anchor) =>
        refs.aiEdit.current ? refs.aiMenu.current(view, anchor) : Promise.resolve(),
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
      open: (image) => refs.imageHandlers.current.open?.(image),
      menu: (image, at) => refs.imageHandlers.current.menu?.(imageMenuTarget(image), at),
    }),
    popupSpace(frame),
    pausedSlot.of([]),
    lockedSlot.of(lockExtensions(refs.locked.current)),
    authorshipSlot.of(marksFor(settings.authorship, doc, noteId)),
    // Undo is CodeMirror's history alone: no Yjs undo manager.
    authorshipUndo(doc),
    yCollab(text, null, { undoManager: false }),
    yjsHistory(note.restoring, note.restoredWrites),
    EditorView.contentAttributes.of({
      'aria-label': t('note.bodyLabel'),
    }),
    editorLayoutWatch,
    countsReporter(
      (counts) => refs.countsReport.current?.(counts),
      () => refs.countsReport.current !== undefined,
      (markdown) => core.noteCounts(markdown),
      (markdown) => tallyNote(core, markdown),
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
      refs.caretLineReport.current?.(update.state.doc.lineAt(head).number)
    }),
    EditorView.domEventHandlers({
      scroll: (_event, scrolled) => {
        const top = editorTop(scrolled, scroller)
        if (!top) return
        place.top = top
        placeChanged()
      },
    }),
  ]
}
