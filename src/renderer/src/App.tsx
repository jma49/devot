import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  BatchChange,
  BookRecord,
  ImportScan,
  NoteStatus,
  NoteSummary,
  SaveProblem,
  TagColor,
  TagRecord,
  TrashedNote,
} from '../../core'
// Imported directly (not through the core index) so the main bundle does not
// pull in the preview pipeline.
import { bookCounts, bookWithDescendants, buildBookTree, TEMPLATES_BOOK_ID } from '../../core/books'
import { noteLink } from '../../core/links'
import { clipTitle } from '../../core/noteLimits'
import {
  EMPTY_TRAIL,
  adjacentNote,
  stepTarget,
  trailTo,
  visit,
  type Trail,
} from '../../core/navigation'
import { highlightTerms, parseSearch, searchPattern, type SearchScope } from '../../core/search'
import { countBucket } from '../../core/usage'
import { filterNotes, noteGroups, statusCounts, tagCounts, type NoteFilter } from '../../core/tags'
import { BACKUP_FAILED, SHOW_BACKUPS, errorCode, listBackups, restoreBackup } from './backups'
import { BackupNotice } from './BackupNotice'
import { ChangeNotice } from './ChangeNotice'
import { ImageNotice } from './ImageNotice'
import { MAX_LINK_NOTES } from './linkCompletion'
import { useNarrowWindow } from './narrowWindow'
import { ExportNotice, failureOf, type ExportFailure } from './ExportNotice'
import { SaveNotice } from './SaveNotice'
import { isImeKey } from './ime'
import { createQuitGuard, newProblems } from './saving'
import { BackupsDialog } from './BackupsDialog'
import { BookPicker } from './BookPicker'
import { ImportDialog, type ImportJob } from './ImportDialog'
import { forgetScanFound, setScanFound } from './importProgress'
import {
  IMPORT_FAILED,
  IMPORT_PROGRESS,
  IMPORT_READY,
  IMPORT_SCANNING,
  finishImport,
  pickImport,
  runImport,
} from './importer'
import { IMPORT_PICKS, type ImportAction } from './bookMenu'
import { BatchNotice } from './BatchNotice'
import { ConfirmDialog } from './ConfirmDialog'
import { CoreNotice } from './CoreNotice'
import { StartFailure } from './StartFailure'
import {
  IMAGE_COMMANDS,
  imageActionApplies,
  runImageAction,
  useImageMenu,
  type ImageAction,
  type ImageMenuTarget,
  type SetImageSize,
} from './imageMenu'
import { ImageViewer, type ViewedImage } from './ImageViewer'
import { useExternalChanges } from './externalChanges'
import { useMarkdownMirror } from './MarkdownMirror'
import { latestOnly } from './preview/latest'
import { SearchField } from './SearchField'
import { areaOf, areaTargets, nextArea, usePaneTab, visible, type Area } from './areas'
import { inEditor, sheetOpen, useMenuEvent, useWindowCommands } from './commands/dispatch'
import { useCommandMenu } from './commands/commandMenu'
import { useFormatMenu } from './commands/formatMenu'
import { useKeymap } from './commands/shortcutSettings'
import { invoke } from './ipc'
import { titleWithKey } from './commands/titles'
import { ToolTips } from './ToolTips'
import { COMMANDS, formatOf, insertOf, tableOf, type CommandHandlers } from './commands/registry'
import { CommandPalette, type PaletteActions } from './palette/CommandPalette'
import {
  commandEntries,
  libraryEntries,
  outlineEntries,
  sourceEntries,
  withTagClause,
} from './palette/entries'
import type { PaletteEntry, PaletteSource } from './palette/results'
import { bookDeleteDetail, noteCount } from './format'
import { openAfter, selectAll, type ListSelection } from './listSelection'
import { SelectionSummary } from './SelectionSummary'
import { TrashView } from './TrashView'
import { Icon } from './icons/Icon'
import { StatusPicker } from './StatusPicker'
import { TagEditor } from './TagEditor'
import { BuiltInTemplate, BuiltInTemplates } from './BuiltInTemplates'
import { markWrite } from './lastWrite'
import { TemplatePicker } from './TemplatePicker'
import { currentRecentTemplates } from './templates'
import { startCore, stopCore, type Core } from './core-client'
import { welcomeContent } from './welcome/content'
import { currentFocusStore, currentSidebarStore, keyboardIsFree } from './focus'
import { useFocusRescue } from './focusRescue'
import { currentLastStateStore, restorePlan, type LastState, type NoteState } from './lastState'
import type { FindTarget } from './find/target'
import { useFind } from './find/useFind'
import { headline } from '../../core/extract'
import { refuseTextDrops } from './dragData'
import { displayTitle, displayTitles, newestUntitled, useHeadlines } from './headlines'
import { currentLocale, format, t } from './i18n'
import { useAlertMenu } from './editor/alertMenu'
import { NoteEditor, type ApplyRestore, type EditorHandle, type EditorPlace } from './NoteEditor'
import {
  changeEditorSettings,
  editorSettings,
  stepEditorFontSize,
  useEditorSetting,
} from './editorSettings'
import { ModeControl, type Mode } from './ModeControl'
import { NoteList } from './NoteList'
import {
  homeOf,
  keepUnchanged,
  retitled,
  sameCounts,
  viewLists,
  withWrites,
  type ListView,
} from './listUpdates'
import { useNoteActions } from './noteActions'
import { useTrashMenu } from './trashMenu'
import {
  NOTE_COMMANDS,
  SELECTION_ONLY,
  TRASH_COMMANDS,
  type ExportAction,
  type NoteAction,
  type NoteMenuAction,
  type TrashAction,
} from './noteMenu'
import { applyOrder, orderChip, orderLabel, sortLocales, sortView, useListOrder } from './noteSort'
import { LivePreview } from './preview/Preview'
import { syncScrolling, type ScrollPane } from './preview/scrollSync'
import { RevisionHistory, useHistoryMenu } from './RevisionHistory'
import { Activity, useActivityMenu } from './Activity'
import { choicesFromTree, notebookForNewNote, publishNotebooks } from './notebookChoices'
import { Sidebar, stepSidebarRow, type Selection } from './Sidebar'
import { useKept, useStable } from './stable'
import { STATUS_COMMANDS } from './statusKeys'
import { textStore } from './textStore'
import { sizes } from './theme/tokens'
import { track } from './usage'

/** File > Export > All Notes (`markdown` or `html`), from Rust's menu. */
const EXPORT_ALL = 'devot:export-all'

/** A query and the view it narrows (none: every note). */
interface Search {
  query: string
  scope: SearchScope | undefined
}

/** A search counts as run (a usage event) once its results have shown this long. */
const SEARCH_SETTLED_MS = 1000

/** View > Command Palette… in the menu bar; App re-sends the Tauri event as this. */
export const SHOW_PALETTE = 'devot:show-palette'

/** View > Toggle Editor and Preview, and View > Show Editor and Preview. */
export const TOGGLE_PREVIEW = 'devot:toggle-preview'
export const SHOW_SPLIT = 'devot:show-split'

/** How many untitled notes the palette looks up the first line of (the newest). */
const PALETTE_HEADLINES = 500
const NO_LIBRARY = { book: [], tag: [], note: [] }

// Props that stay the same object, so the list and the sidebar (memoized)
// do not render again for an equal one.
const NO_NOTES: NoteSummary[] = []
const NO_TAGS: ReadonlyMap<string, TagRecord> = new Map()
const ALL_NOTES: Selection = { kind: 'all' }

/**
 * A title being typed shows in the lists once typing has paused this long:
 * each change re-sorts them, which costs more the more notes there are.
 */
const LIST_TITLE_MS = 150

/** How long `data-pane-motion` stays on: the slide (`motion.duration.pane`) plus a margin. */
const PANE_MOTION_MS = Number.parseFloat(sizes['motion.duration.pane']) + 80

/** View > Hide Sidebar in the menu bar; App re-sends the Tauri event as this. */
export const TOGGLE_SIDEBAR = 'devot:toggle-sidebar'

/**
 * The first menu bar toggle this soon after the key did the same is that key
 * press reaching the menu too (an echo), and is dropped.
 */
const MENU_ECHO_MS = 500

/**
 * The window's last state is saved this long after the selection or a
 * scroll position last changed (at once for a view, note or mode change).
 */
const LAST_STATE_SAVE_MS = 400

/**
 * Saves pending edits before something that reads storage. A note that
 * cannot be saved keeps its changes in the core, which tries again and
 * reports it (the save notice), so what was asked for goes on.
 */
const saveEdits = (core: Core) => core.flush().catch(() => {})

/** Shows the hidden sidebar again, from the list's toolbar. */
function ShowSidebarButton({ onClick }: { onClick: () => void }) {
  // The tooltip names the key in effect.
  useKeymap()
  return (
    <button
      type="button"
      className="tool sidebar-show"
      aria-label={t('command.showSidebar')}
      title={titleWithKey('sidebar.showTitle', 'view.sidebar')}
      onClick={onClick}
    >
      <Icon name="sidebar.toggle" size="lg" />
    </button>
  )
}

/** How long a request for an area waits for it to show. */
const AREA_ASK_MS = 1000

/** Where the keyboard goes once the window has rendered. */
type FocusRequest =
  | { kind: 'area'; area: Area }
  /** `start`: the caret at the start of the body. */
  | { kind: 'title' | 'body'; id: string; start?: boolean }

/** Where the keyboard was when the palette opened, to give it back. */
interface FocusReturn {
  editor: boolean
  element: HTMLElement | null
}

/** The window: sidebar, note list and editor under a unified toolbar. */
export function App() {
  // Where this window was when it last closed (see lastState.ts): its view,
  // filter and mode show at once; the open note once the lists have loaded.
  const lastStateStore = useMemo(() => currentLastStateStore(), [])
  const [lastState] = useState(() => lastStateStore.load())
  // Tooltips name the keys in effect; they follow the user's changes.
  useKeymap()
  const [core, setCore] = useState<Core>()
  // Why the core could not start (a code), until Try Again starts it again;
  // `startAttempt` counts the starts.
  const [startFailure, setStartFailure] = useState<string>()
  const [startAttempt, setStartAttempt] = useState(0)
  // The code of an error the running core worker raised (a notice).
  const [coreFailure, setCoreFailure] = useState<string>()
  // What the lists show for a note with no title (see headlines.ts).
  const loadHeadlines = useMemo(
    () => (core ? (ids: string[]) => core.headlines(ids) : undefined),
    [core],
  )
  // The body excerpts under the rows' titles (see NoteService.excerpts).
  const loadExcerpts = useMemo(
    () => (core ? (ids: string[]) => core.excerpts(ids) : undefined),
    [core],
  )
  // The task progress on the rows (see NoteService.progress).
  const loadProgress = useMemo(
    () => (core ? (ids: string[]) => core.progress(ids) : undefined),
    [core],
  )
  // The lists have loaded once (the last state is restored then).
  const [listsLoaded, setListsLoaded] = useState(false)
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [books, setBooks] = useState<BookRecord[]>([])
  const [library, setLibrary] = useState<Selection>(() => lastState?.view ?? { kind: 'all' })
  const [tags, setTags] = useState<TagRecord[]>([])
  const [filter, setFilter] = useState<NoteFilter | null>(() =>
    lastState?.view.kind === 'templates' ? null : (lastState?.filter ?? null),
  )
  const [trash, setTrash] = useState<TrashedNote[]>([])
  // Notes in Templates: listed in their own view, never in the library.
  const [templates, setTemplates] = useState<NoteSummary[]>([])
  // The built-in (starter) template shown read-only in the Templates view.
  const [builtIn, setBuiltIn] = useState<string>()
  // The template picker (New Note from Template), and the templates used
  // last on this device.
  // The recently used ones are read when it opens. With `into`, the chosen
  // template fills that (empty) note instead of making a new one.
  const [picking, setPicking] = useState<{ recent: string[]; into?: string }>()
  const recentTemplates = useMemo(() => currentRecentTemplates(), [])
  const [query, setQuery] = useState('')
  // Where the query looks: every note, or the notes of the current view.
  const [searchIn, setSearchIn] = useState<'all' | 'view'>('view')
  // The latest results, with the search they answer.
  const [results, setResults] = useState<{
    found: NoteSummary[]
    search: Search
  }>()
  const searchField = useRef<HTMLInputElement>(null)
  const runSearch = useRef<(search: Search) => void>(undefined)
  const latestSearch = useRef<Search>({ query: '', scope: undefined })
  // Results show only while there is a query.
  const searching = query.trim() !== '' && results !== undefined
  // A permanent deletion waiting for the user's confirmation.
  const [confirm, setConfirm] = useState<
    | { kind: 'empty' }
    | { kind: 'one'; id: string; title: string }
    | { kind: 'many'; ids: readonly string[] }
    | { kind: 'tag'; id: string; name: string; count: number }
    | { kind: 'book'; id: string; name: string; subs: number; notes: number }
  >()
  // A notebook just created, shown with its name ready to edit.
  const [renamingBook, setRenamingBook] = useState<string>()
  const [selected, setSelected] = useState<string>()
  // Several notes selected in the list (see listSelection.ts); the open
  // note stays open among them, and the editor pane shows a summary.
  // It belongs to the view it was made in (see `listView`).
  const [multi, setMultiIn] = useState<{
    view: string
    selection: ListSelection
  }>()
  // How many notes the last batch change could not change (a notice).
  const [batchFailed, setBatchFailed] = useState<number>()
  useEffect(() => refuseTextDrops(window), [])
  const [title, setTitle] = useState('')
  // The note whose editor takes the keyboard when it opens: one just created,
  // or one a palette action opened while the editor had the keyboard. Opening
  // one from the list leaves the keyboard there.
  const [takesKeyboard, setTakesKeyboard] = useState<string>()
  const [mode, setMode] = useState<Mode>(() => lastState?.mode ?? 'edit')
  // Focus mode hides the sidebar and the list; each window remembers it.
  const focusStore = useMemo(() => currentFocusStore(), [])
  const [focus, setFocus] = useState(() => focusStore.load())
  const toggleFocus = useCallback(() => {
    setFocus((on) => {
      focusStore.save(!on)
      return !on
    })
  }, [focusStore])
  // Each window remembers whether it hides the sidebar (Cmd+/, View > Hide
  // Sidebar); focus mode hides it too.
  const sidebarStore = useMemo(() => currentSidebarStore(), [])
  const [sidebarHidden, setSidebarHidden] = useState(() => sidebarStore.load())
  // A narrow window hides the sidebar until Show Sidebar asks for it; the
  // request lasts until the window crosses the threshold again, and neither
  // it nor the hiding is stored (the saved choice is the user's own).
  const narrow = useNarrowWindow()
  const [askedIn, setAskedIn] = useState<boolean | null>(null)
  // The request ends when the window is wide again.
  if (!narrow && askedIn !== null) setAskedIn(null)
  const sidebarOff = sidebarHidden || (narrow && askedIn !== narrow)
  const sidebarShown = !focus && !sidebarOff
  // Hiding or showing the sidebar and the list slides them (app.css). The
  // window carries `data-pane-motion` for the length of the slide only, so a
  // first paint never animates. The panes are inert from the first frame of a
  // hide, so the keyboard leaves them as it did when they vanished at once.
  const [panesSeen, setPanesSeen] = useState({ focus, sidebarOff })
  const [paneMotion, setPaneMotion] = useState(false)
  if (panesSeen.focus !== focus || panesSeen.sidebarOff !== sidebarOff) {
    setPanesSeen({ focus, sidebarOff })
    setPaneMotion(true)
  }
  useEffect(() => {
    if (!paneMotion) return
    const timer = setTimeout(() => setPaneMotion(false), PANE_MOTION_MS)
    return () => clearTimeout(timer)
  }, [paneMotion, panesSeen])
  useLayoutEffect(() => {
    document.querySelector('.window > .sidebar')?.toggleAttribute('inert', focus || sidebarOff)
    document.querySelector('.window > .list')?.toggleAttribute('inert', focus)
    // A start that failed is replaced by a fresh window (Try Again): its panes are new.
  }, [focus, sidebarOff, startFailure])
  // The notes this window opened, for Back and Forward. The ref moves at
  // once (quick presses each step on); the state renders it.
  const trailRef = useRef<Trail>(EMPTY_TRAIL)
  const [trail, setTrail] = useState(EMPTY_TRAIL)
  const moveTrail = (next: Trail) => {
    trailRef.current = next
    setTrail(next)
  }
  // The note a navigation is opening, from the moment it starts until the
  // window shows it: quick presses of Back, Forward, Next and Previous step
  // on from it, not from the note still shown. Each open counts up `opens`;
  // only the latest one shows its note.
  const openingRef = useRef<string | undefined>(undefined)
  const opens = useRef(0)
  const startOpening = (id: string) => {
    openingRef.current = id
    return ++opens.current
  }
  useEffect(() => {
    if (openingRef.current === selected) openingRef.current = undefined
  })
  // Where the keyboard goes once the window has rendered (see the effect
  // below); asking re-renders.
  const focusAfter = useRef<FocusRequest>(undefined)
  const focusAskedAt = useRef(0)
  const [, setFocusAsked] = useState(0)
  const requestFocus = (request: FocusRequest) => {
    focusAfter.current = request
    focusAskedAt.current = performance.now()
    setFocusAsked((n) => n + 1)
  }
  const titleRef = useRef<HTMLInputElement>(null)
  // The open note's tag field, which Return in the title goes on to.
  const tagInputRef = useRef<HTMLInputElement>(null)
  // The backups dialog, and the code of a failed automatic backup.
  const [backupsOpen, setBackupsOpen] = useState(false)
  const [backupNotice, setBackupNotice] = useState<string>()
  // The code of a notebook, tag or note change that was refused, shown in a notice.
  const [changeNotice, setChangeNotice] = useState<string>()
  // The codes of pasted or dropped images that could not be stored, shown in a notice.
  const [imageNotice, setImageNotice] = useState<string[]>()
  const [exportNotice, setExportNotice] = useState<{
    failure: ExportFailure
    code: string
  }>()
  // Notes the core could not save yet; it keeps their changes and tries
  // again (saving.ts). Their notice shows unless dismissed since the last
  // new failure; the first quit after they failed is held.
  const [saveProblems, setSaveProblems] = useState<SaveProblem[]>([])
  const [saveNoticeDismissed, setSaveNoticeDismissed] = useState(false)
  const [quitHeld, setQuitHeld] = useState(false)
  const saveProblemsRef = useRef<SaveProblem[]>([])
  const quitGuard = useMemo(() => createQuitGuard(), [])
  const saveNoticeShown = saveProblems.length > 0 && !saveNoticeDismissed
  // Imports: those waiting their turn, and the one the sheet shows (a scan
  // goes on while it waits; its progress and result update its job).
  const importJobs = useRef<ImportJob[]>([])
  const [importJob, setImportJob] = useState<ImportJob>()
  // Each job gets a fresh sheet.
  const [importKey, setImportKey] = useState(0)
  // One sheet at a time: an import never runs while Backups is open (a
  // restore replaces the database under it), and Backups waits for an import.
  const importShown = useRef(false)
  const backupsShown = useRef(false)
  const backupsWanted = useRef(false)
  // Sessions taken (their scan arrived) or closed: later events for them are ignored.
  const seenImports = useRef(new Set<number>())
  // The session of the job the sheet shows.
  const shownImport = useRef<number | null>(null)
  const coreRef = useRef<Core>(undefined)
  // The open note's Markdown, mirrored from the editor for the preview. It
  // is not App state: typing renders only the preview, while it shows.
  const [openText] = useState(() => textStore())
  // The note whose Revision History sheet is open; the editor applies restores.
  const [historyFor, setHistoryFor] = useState<string>()
  // View > Activity… shows the activity heatmap.
  const [activityOpen, setActivityOpen] = useState(false)
  useActivityMenu(() => setActivityOpen(true))
  const restoreRef = useRef<ApplyRestore | null>(null)
  // Find in the open note: the editor's and the preview's handles.
  const [editorFind, setEditorFind] = useState<FindTarget | null>(null)
  const [previewFind, setPreviewFind] = useState<FindTarget | null>(null)
  const editorRef = useRef<EditorHandle | null>(null)
  // Split mode keeps the editor and the preview at the same line, unless
  // turned off (an editor setting: View > Synced Scrolling, the palette).
  const syncScroll = useEditorSetting('syncScroll')
  const [editorPane, setEditorPane] = useState<ScrollPane | null>(null)
  const [previewPane, setPreviewPane] = useState<ScrollPane | null>(null)
  // Coming from Preview, the place being read leads; otherwise the editor does.
  const modeBefore = useRef(mode)
  useEffect(() => {
    const lead = modeBefore.current === 'preview' ? 'second' : 'first'
    modeBefore.current = mode
    if (mode !== 'split' || !syncScroll || !editorPane || !previewPane) return
    return syncScrolling(editorPane, previewPane, { lead })
  }, [mode, syncScroll, editorPane, previewPane])
  // The command palette, and where the keyboard goes back to when it closes.
  const [paletteOpen, setPaletteOpen] = useState(false)
  // The source the palette opens scoped to (the sidebar's search buttons), and
  // the open note's Markdown as it was then (the outline source lists it).
  const [paletteScope, setPaletteScope] = useState<PaletteSource | undefined>()
  const [paletteText, setPaletteText] = useState('')
  // Whether the editor's cursor was in a table when the palette opened: the
  // palette offers the table commands then.
  const [paletteInTable, setPaletteInTable] = useState(false)
  // Whether text was selected in the editor when the palette opened: the
  // palette offers New Note from Selection then.
  const [paletteSelection, setPaletteSelection] = useState(false)
  // The image at the editor's cursor when the palette opened: the palette
  // offers the image commands for it then.
  const [paletteImage, setPaletteImage] = useState<ImageMenuTarget | null>(null)
  // The image shown in the viewer (double-click on an image).
  const [viewing, setViewing] = useState<ViewedImage | null>(null)
  const paletteReturn = useRef<FocusReturn>(undefined)
  // While a palette action picked from the editor runs, a note it opens
  // takes the keyboard into its editor.
  const paletteFromEditor = useRef(false)
  // Counts palette actions that have finished; see `closePalette`.
  const [paletteDone, setPaletteDone] = useState(0)

  const refresh = useCallback(async (c: Core) => {
    const [listed, nextBooks, nextTags, nextTrash] = await Promise.all([
      c.listWithTemplates(),
      c.listBooks(),
      c.listTags(),
      c.listTrash(),
    ])
    const nextNotes = listed.notes
    setTrash(nextTrash)
    // Notes that did not change keep their objects (and their rows their render).
    setTemplates((prev) => keepUnchanged(prev, listed.templates))
    setNotes((prev) => keepUnchanged(prev, nextNotes))
    setBooks(nextBooks)
    setTags(nextTags.sort((a, b) => a.name.localeCompare(b.name)))
    // Results follow edits, renames, trash and restore.
    if (latestSearch.current.query.trim()) runSearch.current?.(latestSearch.current)
    return { notes: nextNotes, templates: listed.templates, books: nextBooks }
  }, [])

  // Every note write (a save, above all) dates the note in the lists at once:
  // an edited note moves to where its new date puts it, without a reload.
  // A change that reloads the lists when done (see `changeBooks`) is not
  // shown write by write: a note it re-dates could move in the list before
  // the reload takes it out, and the keyboard would go to the wrong row.
  const reloadsPending = useRef(0)
  const showWrites = useCallback((writes: ReadonlyMap<string, number>) => {
    // The sidebar's footer shows when the last write was.
    for (const at of writes.values()) markWrite(at)
    if (reloadsPending.current > 0) return
    setNotes((list) => withWrites(list, writes))
    setTemplates((list) => withWrites(list, writes))
    setResults((shown) => {
      const found = shown && withWrites(shown.found, writes)
      return shown && found !== shown.found ? { ...shown, found: found! } : shown
    })
  }, [])

  /**
   * The core's list of notes not saved yet: each new failure is logged by
   * code and brings the notice back; once a note saves after failing, the
   * lists show what is stored now.
   */
  const onSaveProblems = useCallback(
    (next: SaveProblem[]) => {
      const previous = saveProblemsRef.current
      saveProblemsRef.current = next
      const fresh = newProblems(previous, next)
      for (const problem of fresh) console.warn('W_NOTE_SAVE_FAILED', problem.id, problem.code)
      if (fresh.length > 0) setSaveNoticeDismissed(false)
      quitGuard.update(next)
      if (next.length === 0) setQuitHeld(false)
      setSaveProblems(next)
      const c = coreRef.current
      if (c && previous.some((p) => !next.some((n) => n.id === p.id))) {
        void refresh(c).catch(() => {})
      }
    },
    [quitGuard, refresh],
  )

  // Changes of view made from callbacks that outlive a render (a finished
  // import, New Notebook) go through the latest rules (see `showLibrary`).
  const showLibraryRef =
    useRef<(next: Selection, options?: { clearFilter?: boolean }) => void>(undefined)

  /**
   * Shows the next sheet unless one is up: an import job first (every
   * result stays until the user closes it; an import ends by showing its
   * notebook), then Backups if it was asked for meanwhile.
   */
  const nextSheet = useCallback(() => {
    if (importShown.current || backupsShown.current) return
    const c = coreRef.current
    const job = c ? importJobs.current.shift() : undefined
    if (!c || !job) {
      if (backupsWanted.current) {
        backupsWanted.current = false
        backupsShown.current = true
        setBackupsOpen(true)
      }
      return
    }
    importShown.current = true
    shownImport.current = job.id
    setImportKey((k) => k + 1)
    setImportJob(job)
  }, [])

  /** Runs the import the sheet asked for; it shows the result or the failure. */
  const startImport = useCallback(
    async (
      scan: ImportScan,
      destination: string | null,
      progress: (done: number, total: number) => void,
    ) => {
      const c = coreRef.current
      if (!c) throw new Error('E_CORE_NOT_READY')
      try {
        await saveEdits(c)
        const started = performance.now()
        const report = await runImport(c, scan, destination, progress)
        track('import.finished', {
          notes: report?.notes ?? 0,
          notebooks: report?.books ?? 0,
          images: report?.attachments ?? 0,
          problems: report?.problems.length ?? scan.skipped.length,
          durationMs: Math.round(performance.now() - started),
        })
        await refresh(c)
        if (report?.bookId) {
          showLibraryRef.current?.({ kind: 'book', id: report.bookId }, { clearFilter: true })
        }
        return report
      } catch (e) {
        console.warn('W_IMPORT_FAILED', errorCode(e))
        await refresh(c).catch(() => {})
        throw new Error(errorCode(e), { cause: e })
      }
    },
    [refresh],
  )

  const closeImport = (cancelled: boolean) => {
    // Cancelled before Import: the session (or the scan still running) ends.
    const id = importJob?.id ?? null
    if (id !== null) forgetScanFound(id)
    if (cancelled && id !== null) {
      seenImports.current.add(id)
      void finishImport(id)
    }
    setImportJob(undefined)
    importShown.current = false
    shownImport.current = null
    nextSheet()
  }

  const showBackups = useCallback(() => {
    backupsWanted.current = true
    nextSheet()
  }, [nextSheet])

  const closeBackups = () => {
    setBackupsOpen(false)
    backupsShown.current = false
    nextSheet()
  }

  const tree = useMemo(() => buildBookTree(books), [books])
  // The Settings window offers these as the default notebook.
  useEffect(() => publishNotebooks(choicesFromTree(tree)), [tree])
  const counts = useKept(
    useMemo(() => bookCounts(notes, books), [notes, books]),
    sameCounts,
  )
  const libraryBook = library.kind === 'book' ? books.find((b) => b.id === library.id) : undefined
  const inTrash = library.kind === 'trash'
  const inTemplates = library.kind === 'templates'
  const keptTrashRows = useRef<NoteSummary[]>([])
  const trashRows = useMemo(
    () =>
      (keptTrashRows.current = keepUnchanged(
        keptTrashRows.current,
        trash.map((n): NoteSummary => ({
          id: n.id,
          title: n.title,
          createdAt: n.deletedAt,
          updatedAt: n.deletedAt,
          bookId: n.bookId,
          status: 'none',
          pinned: false,
          tagIds: [],
        })),
      )),
    [trash],
  )
  // A filter on a deleted tag falls back to none, like a deleted notebook.
  const activeFilter =
    inTemplates || (filter?.kind === 'tag' && !tags.some((tag) => tag.id === filter.tagId))
      ? null
      : filter
  // Each view (a library, a filter, search results) keeps its own order.
  const listOrder = useListOrder(
    sortView({
      search: searching,
      bookId: inTemplates ? TEMPLATES_BOOK_ID : (libraryBook?.id ?? null),
      filter: activeFilter,
    }),
  )
  const order = listOrder.order
  // What the note list shows; see NoteList's `view`.
  const listView = searching
    ? `search|${JSON.stringify(results.search)}`
    : inTrash
      ? 'trash'
      : inTemplates
        ? 'templates'
        : `${sortView({ search: false, bookId: null, filter: activeFilter })}|${libraryBook?.id ?? ''}`
  // The selection toolbar's alert pop-up, built once for the window.
  const showAlertMenu = useAlertMenu()
  // The image context menu (preview and editor); its sizes go through the editor.
  const setImageSize = useCallback<SetImageSize>((source, size) => {
    editorRef.current?.setImageSize(source, size)
  }, [])
  const showImageMenu = useImageMenu(setImageSize)
  const locales = useMemo(() => sortLocales(navigator.languages, currentLocale()), [])
  const sortButtonRef = useRef<HTMLButtonElement>(null)
  const showOrder = listOrder.show
  const sortButton = useMemo(
    () => ({
      label: format(t('sort.current'), { order: orderLabel(order) }),
      chip: orderChip(order),
      onOpen: (anchor: HTMLElement) => void showOrder(anchor),
    }),
    [order, showOrder],
  )
  const groups = useMemo(
    () =>
      noteGroups(
        applyOrder(
          filterNotes(notes, books, {
            bookId: libraryBook?.id ?? null,
            by: activeFilter,
          }),
          order,
          locales,
        ),
      ),
    [notes, books, libraryBook, activeFilter, order, locales],
  )
  const templateRows = useMemo(
    () => noteGroups(applyOrder(templates, order, locales)),
    [templates, order, locales],
  )
  const shownResults = useMemo(
    () => applyOrder(results?.found ?? [], order, locales),
    [results, order, locales],
  )
  const tagsById = useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags])
  const statuses = useKept(
    useMemo(() => statusCounts(notes), [notes]),
    sameCounts,
  )
  const tagged = useKept(
    useMemo(() => tagCounts(notes), [notes]),
    sameCounts,
  )
  const pinnedCount = useMemo(() => notes.filter((n) => n.pinned).length, [notes])
  const filterLabel =
    activeFilter === null
      ? undefined
      : activeFilter.kind === 'pinned'
        ? t('sidebar.pinned')
        : activeFilter.kind === 'status'
          ? t(`status.${activeFilter.status}`)
          : tags.find((tag) => tag.id === activeFilter.tagId)?.name
  const selectedNote =
    notes.find((n) => n.id === selected) ?? templates.find((n) => n.id === selected)
  const selectedIsTemplate = selectedNote?.bookId === TEMPLATES_BOOK_ID
  // The view a search can narrow (the Trash is never searched).
  const viewName =
    filterLabel !== undefined && libraryBook
      ? format(t('search.filterInBook'), {
          filter: filterLabel,
          book: libraryBook.name,
        })
      : (filterLabel ?? libraryBook?.name ?? t('sidebar.allNotes'))
  const inView = searchIn === 'view' && !inTrash && !inTemplates
  // A search over every note shows nothing in the sidebar as selected; the
  // view comes back when the search is cleared, and a row pressed meanwhile
  // shows its own view.
  const searchingAll = searching && !inView
  /**
   * Shows All Notes, a notebook, Templates or the Trash. Every change of view
   * goes through here (the sidebar, the palette, New Notebook, a finished
   * import), so the same rules apply to all of them:
   * - the search is cleared, and a search over every note, which hid the
   *   view, also drops the filter that did not show as pressed;
   * - switching between the Trash and the rest closes the open note;
   * - filters narrow the library, not Templates.
   * `clearFilter` also turns the filter off (the arrow keys in the sidebar,
   * a finished import).
   */
  const showLibrary = (next: Selection, options?: { clearFilter?: boolean }) => {
    const clearFilter = searchingAll || options?.clearFilter || next.kind === 'templates'
    clearSearch()
    if ((next.kind === 'trash') !== inTrash) setSelected(undefined)
    if (clearFilter) setFilter(null)
    setLibrary(next)
  }
  /** Turns a filter on or off; it covers every note, whatever view was shown. */
  const showFilter = (next: NoteFilter | null) => {
    // A search over every note hid its notebook: the filter pressed covers every note.
    const everyNote = searchingAll || inTrash || inTemplates
    clearSearch()
    if (everyNote) showLibrary({ kind: 'all' })
    setFilter(next)
  }
  useEffect(() => {
    showLibraryRef.current = showLibrary
  })
  const viewBookId = libraryBook?.id ?? null
  const searchScope = useMemo<SearchScope | undefined>(
    () => (inView ? { bookId: viewBookId, filter: activeFilter } : undefined),
    [inView, viewBookId, activeFilter],
  )
  // Marks follow the query the results answer, not one still being typed.
  const resultsQuery = results?.search.query ?? ''
  const highlight = useMemo(() => {
    const terms = highlightTerms(parseSearch(resultsQuery))
    return {
      title: searchPattern(terms.title),
      body: searchPattern(terms.body),
    }
  }, [resultsQuery])

  // The notes the list shows, in its order, for the next and previous note.
  const listedIds = useMemo(
    () =>
      (searching
        ? shownResults
        : inTrash
          ? trash
          : inTemplates
            ? [...templateRows.pinned, ...templateRows.others]
            : activeFilter?.kind === 'pinned'
              ? groups.pinned
              : [...groups.pinned, ...groups.others]
      ).map((n) => n.id),
    [searching, shownResults, inTrash, trash, inTemplates, templateRows, activeFilter, groups],
  )
  // The multiple selection, kept to the notes listed: fewer than two left
  // is none. Another view starts without one.
  const setMulti = (selection: ListSelection | undefined) =>
    setMultiIn(selection ? { view: listView, selection } : undefined)
  const listedSet = useMemo(() => new Set(listedIds), [listedIds])
  const shownSelection = useMemo(() => {
    if (!multi || multi.view !== listView) return undefined
    const ids = multi.selection.ids.filter((id) => listedSet.has(id))
    return ids.length > 1 ? { ...multi.selection, ids } : undefined
  }, [multi, listView, listedSet])
  const multiIds = shownSelection?.ids
  // Another view starts without a selection, also when this one comes back.
  if (multi && multi.view !== listView) setMultiIn(undefined)
  const noteById = useMemo(
    () => new Map([...notes, ...templates, ...trashRows].map((n) => [n.id, n])),
    [notes, templates, trashRows],
  )
  const selectedNotes = useMemo(
    () => multiIds?.flatMap((id) => noteById.get(id) ?? []) ?? [],
    [multiIds, noteById],
  )

  const onCoreFailure = useCallback((code: string) => {
    console.error(code)
    setCoreFailure(code)
  }, [])
  useEffect(() => {
    let alive = true
    let started: Core | undefined
    void startCore(onSaveProblems, showWrites, onCoreFailure)
      .then(async (c) => {
        started = c
        if (!alive) return
        setCore(() => c)
        coreRef.current = c
        // A library that has never held anything starts with a few notes. The
        // UI tests' libraries start empty, unless a test asks for the notes.
        if (!DEVOT_UI_TEST || (globalThis as { devotSeedWelcome?: boolean }).devotSeedWelcome) {
          await c.seedWelcome(welcomeContent()).catch((e: unknown) => {
            console.warn('W_WELCOME_FAILED', errorCode(e))
          })
        }
        await refresh(c)
        setListsLoaded(true)
        // Folders picked before the core was ready.
        nextSheet()
      })
      .catch((e: unknown) => {
        if (!alive) return
        // Not an empty library: the window says why it has none.
        if (started) stopCore(started)
        coreRef.current = undefined
        setCore(undefined)
        const code = errorCode(e)
        console.warn('W_CORE_START_FAILED', code)
        setStartFailure(code)
      })
    return () => {
      alive = false
    }
  }, [refresh, nextSheet, onSaveProblems, showWrites, onCoreFailure, startAttempt])
  const retryStart = () => {
    setStartFailure(undefined)
    setStartAttempt((n) => n + 1)
  }

  // Search: newest query wins, run shortly after typing stops.
  useEffect(() => {
    if (!core) return
    runSearch.current = latestOnly(
      async (search: Search) => ({
        found: await core.search(search.query, search.scope),
        search,
      }),
      // Results that did not change keep their objects (and their rows their render).
      (next) => {
        // An answer that lands after the field was cleared is not kept: the
        // next query would first show it.
        if (!latestSearch.current.query.trim()) return
        setResults((shown) =>
          shown ? { ...next, found: keepUnchanged(shown.found, next.found) } : next,
        )
      },
      () => console.warn('W_SEARCH_FAILED'),
    )
  }, [core])
  useEffect(() => {
    const search = { query, scope: searchScope }
    latestSearch.current = search
    if (!query.trim()) return
    const timer = setTimeout(() => runSearch.current?.(search), 120)
    return () => clearTimeout(timer)
  }, [query, searchScope])
  // A usage event once typing has paused and the results answer the query.
  // Results that follow a change, or the same query in the same place
  // again, are not a new search.
  const countedSearch = useRef('')
  useEffect(() => {
    if (!query.trim()) {
      countedSearch.current = ''
      return
    }
    if (results?.search.query !== query || !!results.search.scope !== inView) return
    const key = `${inView ? 'view' : 'all'}\n${query}`
    if (countedSearch.current === key) return
    const { found } = results
    const timer = setTimeout(() => {
      countedSearch.current = key
      track('search.run', {
        scope: inView ? 'view' : 'all',
        clauses: parseSearch(query).length,
        results: countBucket(found.length),
      })
    }, SEARCH_SETTLED_MS)
    return () => clearTimeout(timer)
  }, [query, results, inView])
  // Typing a search in the Trash or Templates leaves it: neither is ever
  // searched.
  const changeQuery = (next: string) => {
    if ((inTrash || inTemplates) && next.trim()) {
      if (inTrash) setSelected(undefined)
      setLibrary({ kind: 'all' })
      setSearchIn('all')
    }
    // With no query the old results go: typing again must not show them
    // while the new search runs.
    if (!next.trim()) setResults(undefined)
    setQuery(next)
  }
  function clearSearch() {
    setResults(undefined)
    setQuery('')
    setSearchIn('view')
  }
  // The search shortcuts focus the field from anywhere: Shift+Cmd+F (or /
  // in the list) searches the current view, Shift+Opt+Cmd+F every note.
  // Results need the list, so they leave focus mode first; the field shows
  // after that render.
  const [searchRequest, setSearchRequest] = useState(0)
  const startSearch = useCallback(
    (where: 'all' | 'view') => {
      focusStore.save(false)
      setFocus(false)
      setSearchIn(where)
      setSearchRequest((n) => n + 1)
    },
    [focusStore],
  )
  useEffect(() => {
    if (searchRequest === 0) return
    searchField.current?.focus()
    searchField.current?.select()
  }, [searchRequest])

  // Backups: the menu opens the dialog; a failed backup shows a notice.
  useEffect(() => {
    // Rust sends the menu event to this window even while Settings or a
    // native panel has the keyboard; then it must open nothing behind it.
    const show = () => {
      if (document.hasFocus()) showBackups()
    }
    const failed = (e: Event) => setBackupNotice(errorCode((e as CustomEvent).detail))
    window.addEventListener(SHOW_BACKUPS, show)
    window.addEventListener(BACKUP_FAILED, failed)
    // A failure from before the page loaded.
    listBackups().then(
      (status) => status.lastError && setBackupNotice(status.lastError),
      () => {},
    )
    let unlisten: (() => void)[] = []
    if (!DEVOT_UI_TEST) {
      void import('@tauri-apps/api/event').then(async ({ listen }) => {
        unlisten = await Promise.all([
          listen('devot://show-backups', () => window.dispatchEvent(new CustomEvent(SHOW_BACKUPS))),
          listen<string>('devot://backup-failed', (e) =>
            window.dispatchEvent(new CustomEvent(BACKUP_FAILED, { detail: e.payload })),
          ),
        ])
      })
    }
    return () => {
      window.removeEventListener(SHOW_BACKUPS, show)
      window.removeEventListener(BACKUP_FAILED, failed)
      for (const stop of unlisten) stop()
    }
  }, [showBackups])

  // Import: Rust says a scan started and how far it got, then sends what it
  // found (picked files come straight away) or why it failed. Each import
  // waits its turn; a scan is taken once even if sent twice.
  useEffect(() => {
    /** Changes the job of session `id`, shown or waiting; false when there is none. */
    const update = (id: number, change: (job: ImportJob) => ImportJob) => {
      if (shownImport.current === id) {
        setImportJob((job) => (job && job.id === id ? change(job) : job))
        return true
      }
      const at = importJobs.current.findIndex((job) => job.id === id)
      if (at === -1) return false
      importJobs.current[at] = change(importJobs.current[at]!)
      return true
    }
    const add = (job: ImportJob) => {
      importJobs.current.push(job)
      nextSheet()
    }
    const scanning = (e: Event) => {
      const { id, name, kind } = (
        e as CustomEvent<Pick<ImportJob, 'name' | 'kind'> & { id: number }>
      ).detail
      if (seenImports.current.has(id) || update(id, (job) => job)) return
      add({ id, name, kind, scan: null, failed: null })
    }
    const progress = (e: Event) => {
      const { id, files, images } = (
        e as CustomEvent<{ id: number; files: number; images: number }>
      ).detail
      if (seenImports.current.has(id)) return
      // Kept out of App state: only the sheet showing it renders again.
      const known = shownImport.current === id || importJobs.current.some((job) => job.id === id)
      if (known) setScanFound(id, { files, images })
    }
    const ready = (e: Event) => {
      const scan = (e as CustomEvent<ImportScan>).detail
      if (seenImports.current.has(scan.id)) return
      seenImports.current.add(scan.id)
      if (update(scan.id, (job) => ({ ...job, scan }))) return
      add({ id: scan.id, name: scan.name, kind: scan.kind, scan, failed: null })
    }
    const failed = (e: Event) => {
      const detail = (e as CustomEvent<{ id: number | null; code: unknown } | string>).detail
      const id = typeof detail === 'object' && detail !== null ? detail.id : null
      const code = errorCode(typeof detail === 'object' && detail !== null ? detail.code : detail)
      if (id !== null) {
        if (seenImports.current.has(id)) return
        seenImports.current.add(id)
        if (update(id, (job) => ({ ...job, failed: code }))) return
      }
      add({
        id,
        name: '',
        kind: 'folder',
        scan: null,
        failed: code,
      })
    }
    window.addEventListener(IMPORT_SCANNING, scanning)
    window.addEventListener(IMPORT_PROGRESS, progress)
    window.addEventListener(IMPORT_READY, ready)
    window.addEventListener(IMPORT_FAILED, failed)
    let stopped = false
    const unlisten: (() => void)[] = []
    if (!DEVOT_UI_TEST) {
      void import('@tauri-apps/api/event').then(async ({ listen }) => {
        const resend = (from: string, to: string) =>
          listen<unknown>(from, (e) =>
            window.dispatchEvent(new CustomEvent(to, { detail: e.payload })),
          )
        const stops = await Promise.all([
          resend('devot://import-scanning', IMPORT_SCANNING),
          resend('devot://import-progress', IMPORT_PROGRESS),
          resend('devot://import-ready', IMPORT_READY),
          resend('devot://import-failed', IMPORT_FAILED),
        ])
        // Cleaned up before the listeners were ready: stop them now.
        if (stopped) for (const stop of stops) stop()
        else unlisten.push(...stops)
      })
    }
    return () => {
      stopped = true
      window.removeEventListener(IMPORT_SCANNING, scanning)
      window.removeEventListener(IMPORT_PROGRESS, progress)
      window.removeEventListener(IMPORT_READY, ready)
      window.removeEventListener(IMPORT_FAILED, failed)
      for (const stop of unlisten) stop()
    }
  }, [nextSheet])

  // Another process (devot-mcp) changed the database. Notes in memory take
  // in what it wrote before anything of theirs is saved, so no save writes
  // over it, and the open note shows it. Then pending edits are saved, so
  // the lists show them, and the lists reload.
  useExternalChanges(
    core
      ? async () => {
          const shown = selected && !inTrash ? selected : undefined
          const navigation = opens.current
          const titled = await core.mergeStored()
          // The open editor's replica takes in only what it lacks.
          const editor = editorRef.current?.noteId === shown ? editorRef.current : null
          const opened = shown
            ? await core.open(shown, editor?.vector()).catch(() => undefined)
            : undefined
          // Unless the window has moved on to another note meanwhile.
          if (opened && opens.current === navigation) {
            const outsideTitle = titled.find((note) => note.id === opened.id)?.title
            if (outsideTitle !== undefined) setTitle(outsideTitle)
            const now = editorRef.current
            if (now?.noteId === opened.id) {
              // An editor that opened meanwhile takes the whole state.
              const state =
                now === editor
                  ? opened.state
                  : (await core.open(opened.id).catch(() => undefined))?.state
              if (state && editorRef.current === now) now.takeState(state)
            }
          }
          await saveEdits(core)
          // The mirror follows notes devot-mcp wrote at its next pass.
          void core.mirrorTouch()
          await refresh(core)
        }
      : undefined,
  )

  /** Saves pending edits, restores the backup, then reloads everything. */
  const restore = async (id: string) => {
    // No import runs while Backups is open; stopping one is a safeguard.
    await core?.stopImport()
    if (core) await saveEdits(core)
    await restoreBackup(
      id,
      core
        ? {
            hold: () => core.holdCompaction(),
            resume: () => core.resumeCompaction(),
          }
        : undefined,
    )
    // Folders picked meanwhile were never imported: close their sessions.
    for (const job of importJobs.current.splice(0)) {
      if (job.id !== null) {
        forgetScanFound(job.id)
        await finishImport(job.id)
      }
    }
    window.location.reload()
  }

  // Save pending edits before the page goes away (quit, reload, close).
  useEffect(() => {
    if (!core) return
    const flush = () => void saveEdits(core)
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', flush)
    // Quitting: Rust holds the exit, asks us to save, and exits on our reply.
    // When a note could not be saved, the first such quit is called off
    // instead: the window stays with the changes and the notice says so
    // (saving.ts); quitting again goes on without them.
    let unlisten: (() => void) | undefined
    if (!DEVOT_UI_TEST) {
      void import('@tauri-apps/api/event').then(async ({ listen }) => {
        unlisten = await listen('devot://flush-before-exit', async () => {
          saveNow.current?.()
          // A running import stops after the file it is on, so no note
          // is left half made (unless that file outlasts the quit timeout).
          await core.stopImport()
          if ((await quitGuard.answer(core.flush({ versions: true }))) === 'hold') {
            setQuitHeld(true)
            setSaveNoticeDismissed(false)
            await invoke('app_exit_cancel')
            return
          }
          // A mirror pass ends after the batch it is in, so its manifest
          // lists every file it wrote; the next launch catches up.
          await core.mirrorStop()
          await invoke('app_exit_ready')
        })
      })
    }
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', flush)
      unlisten?.()
    }
  }, [core, quitGuard])

  /**
   * Opens a note; whether it opened. Its editor takes the keyboard only when
   * asked (`keyboard`: a note just created, or one opened by a key pressed
   * in the editor), or for one a palette action picked from the editor
   * opens. A note opened becomes the trail's newest entry, unless Back or
   * Forward opens it (`fromTrail`). An open overtaken by a later one (quick
   * key presses) leaves the selection to that one.
   */
  const select = async (
    id: string,
    {
      keyboard = false,
      fromTrail = false,
      keepSelection = false,
    }: {
      keyboard?: boolean
      fromTrail?: boolean
      keepSelection?: boolean
    } = {},
  ): Promise<boolean> => {
    if (!core) return false
    // Opening a note shows it alone, unless the selection itself moved the
    // open note (`keepSelection`).
    if (!keepSelection) setMulti(undefined)
    // A built-in template shown gives way to the note.
    setBuiltIn(undefined)
    const open = startOpening(id)
    await saveEdits(core)
    // A link may point at a note that is gone; leave the selection alone then.
    // The note loads in the core for its editor; only its title comes here.
    const title = await core.title(id).catch((e: unknown) => {
      console.warn('W_NOTE_OPEN_FAILED', id, errorCode(e))
      return undefined
    })
    if (open !== opens.current) return false
    if (title === undefined) {
      openingRef.current = undefined
      return false
    }
    // The open note's editor stays mounted and does not report its text
    // again: keep the preview's copy.
    if (id !== selected) openText.set('')
    setTakesKeyboard(keyboard || paletteFromEditor.current ? id : undefined)
    setSelected(id)
    setTitle(title)
    if (!fromTrail) moveTrail(visit(trailRef.current, id))
    return true
  }

  // The window's last state. Nothing is saved until it has been restored, so
  // a window that is still loading never overwrites it.
  const [restored, setRestored] = useState(false)
  // The Markdown mirror starts once the window has restored its view.
  const mirror = useMarkdownMirror(core, restored)
  // Where the user is in the open note, as last reported (the editor's
  // selection and scroll position, the preview's scroll position).
  const noteState = useRef<NoteState>(undefined)
  // The state outside the Trash, which is kept while the Trash shows.
  const libraryState = useRef<LastState>(undefined)
  // The restored note's place in the editor and the preview, taken once
  // when that note has loaded.
  const restoreEditor = useRef<{ id: string; place: Partial<EditorPlace> }>(undefined)
  const restorePreview = useRef<{ id: string; top: number }>(undefined)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  /** The window's state now; in the Trash, the state from before it. */
  const currentState = (): LastState | undefined => {
    const known = noteState.current
    if (inTrash) {
      const before = libraryState.current
      // Where the user was in the note left for the Trash, as last reported.
      if (before?.note && known?.id === before.note.id) {
        return { ...before, note: { ...known, keyboard: false } }
      }
      return before
    }
    let note: NoteState | undefined
    if (selected !== undefined) {
      note = {
        ...(known?.id === selected ? known : { id: selected }),
        keyboard: inEditor(document.activeElement),
      }
    }
    const state: LastState = {
      view: inTemplates
        ? { kind: 'templates' }
        : libraryBook
          ? { kind: 'book', id: libraryBook.id }
          : { kind: 'all' },
      filter: activeFilter,
      mode,
      ...(note ? { note } : {}),
    }
    libraryState.current = state
    return state
  }
  const saveNow = useRef<() => void>(undefined)
  saveNow.current = () => {
    clearTimeout(saveTimer.current)
    if (!restored) return
    const state = currentState()
    if (state) lastStateStore.save(state)
  }
  /** Saves once the selection or scrolling has paused. */
  const saveSoon = useCallback(() => {
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => saveNow.current?.(), LAST_STATE_SAVE_MS)
  }, [])
  // A view, note or mode change is saved at once.
  useEffect(() => saveNow.current?.(), [restored, library, filter, selected, mode])
  // So is the state when the page goes away or out of sight, and the
  // keyboard moving in or out of the editor soon after.
  useEffect(() => {
    const save = () => saveNow.current?.()
    window.addEventListener('pagehide', save)
    document.addEventListener('visibilitychange', save)
    document.addEventListener('focusin', saveSoon)
    return () => {
      window.removeEventListener('pagehide', save)
      document.removeEventListener('visibilitychange', save)
      document.removeEventListener('focusin', saveSoon)
      clearTimeout(saveTimer.current)
    }
  }, [saveSoon])
  /** The editor reported where the user is in its note. */
  const editorPlaced = (id: string, place: EditorPlace) => {
    const known = noteState.current?.id === id ? noteState.current : { id, keyboard: false }
    noteState.current = {
      ...known,
      selection: place.selection,
      ...(place.top ? { editorTop: place.top } : {}),
    }
    saveSoon()
  }
  /** The user scrolled the preview of the open note. */
  const previewScrolled = (top: number) => {
    if (selected === undefined) return
    const known = noteState.current?.id === selected ? noteState.current : undefined
    noteState.current = {
      ...(known ?? { id: selected, keyboard: false }),
      previewTop: top,
    }
    saveSoon()
  }
  // The view and filter the window started with: a view picked while it
  // loads is the user's, and the restore leaves it alone.
  const startView = useRef({ library, filter })
  // Restores the last state once the lists have loaded: the view and filter
  // (a notebook or tag gone since falls back to none) and the open note with
  // its place, unless it is gone. Its editor takes the keyboard if it had it.
  // Opening it makes it the first entry of Back and Forward's trail.
  const restoreStarted = useRef(false)
  // The note whose editor takes the keyboard from the restore, if nobody has it then.
  const restoreKeyboard = useRef<string>(undefined)
  useEffect(() => {
    if (restoreKeyboard.current !== selected) restoreKeyboard.current = undefined
  }, [selected])
  const restoreLast = async () => {
    try {
      const untouched =
        JSON.stringify({ library, filter }) === JSON.stringify(startView.current) &&
        selected === undefined
      const plan =
        lastState && untouched
          ? restorePlan(lastState, {
              books: new Set(books.map((b) => b.id)),
              tags: new Set(tags.map((tag) => tag.id)),
              notes: new Set([...notes, ...templates].map((n) => n.id)),
            })
          : undefined
      if (!plan) return
      setLibrary(plan.view)
      setFilter(plan.filter)
      const note = plan.note
      if (!note) return
      noteState.current = note
      const place: Partial<EditorPlace> = {}
      if (note.selection) place.selection = note.selection
      if (note.editorTop) place.top = note.editorTop
      restoreEditor.current = { id: note.id, place }
      const preview = mode === 'preview'
      if (preview && note.previewTop !== undefined) {
        restorePreview.current = { id: note.id, top: note.previewTop }
      }
      // The keyboard goes to the editor only while it is nobody's: a search
      // typed or focus put anywhere since launch is the user's, here and
      // once the editor has loaded (`restoreKeyboard`).
      const keyboard = note.keyboard && !preview && query === '' && keyboardIsFree()
      if (keyboard) restoreKeyboard.current = note.id
      await select(note.id, { keyboard })
    } catch {
      console.warn('W_LAST_STATE_RESTORE_FAILED')
    } finally {
      setRestored(true)
    }
  }
  useEffect(() => {
    if (!core || !listsLoaded || restoreStarted.current) return
    restoreStarted.current = true
    void restoreLast()
  })
  const takeEditorPlace = (id: string) => () => {
    const pending = restoreEditor.current
    restoreEditor.current = undefined
    return pending?.id === id ? pending.place : undefined
  }
  const takePreviewScroll = () => {
    const pending = restorePreview.current
    restorePreview.current = undefined
    return pending && pending.id === selected ? pending.top : undefined
  }

  /** Puts a trashed note back where it was. */
  const restoreTrashed = async (id: string) => {
    await changeBooks((c) => c.restore(id))
    setSelected(undefined)
  }
  const confirmDelete = async (id: string) => {
    const note = trash.find((n) => n.id === id)
    const named = await displayTitles(loadHeadlines, [{ id, title: note?.title ?? '' }])
    setConfirm({ kind: 'one', id, title: named.get(id) ?? '' })
  }
  const trashAction = (action: TrashAction, id: string) => {
    // On a row of a multiple selection, the keys act on every selected note.
    const many = multiIds?.includes(id) ? multiIds : undefined
    if (many) return action === 'restore' ? restoreNotes(many) : confirmDeleteMany(many)
    return action === 'restore' ? restoreTrashed(id) : confirmDelete(id)
  }
  const confirmDeleteMany = (ids: readonly string[]) => setConfirm({ kind: 'many', ids })

  const runConfirmed = async () => {
    const pending = confirm
    setConfirm(undefined)
    if (!pending) return
    if (pending.kind === 'tag') return void (await changeBooks((c) => c.deleteTag(pending.id)))
    if (pending.kind === 'book') return void (await deleteBook(pending.id))
    if (pending.kind === 'many') {
      await runBatch(pending.ids, { kind: 'purge' })
      setMulti(undefined)
      return setSelected(undefined)
    }
    await changeBooks((c) => (pending.kind === 'empty' ? c.emptyTrash() : c.purge(pending.id)))
    setSelected(undefined)
  }

  /**
   * Shows a note just made (New Note, Duplicate, New Note from Template;
   * `listed`: the lists reloaded since) in the list. When the view would not
   * list it (the Trash, Templates for a note, the library for a template,
   * another notebook, a filter it does not match, search results without
   * it), the view that does shows instead: its notebook, All Notes or
   * Templates, without a filter or a search.
   */
  const showMade = async (
    c: Core,
    id: string,
    listed: {
      notes: NoteSummary[]
      templates: NoteSummary[]
      books: BookRecord[]
    },
  ) => {
    const made = listed.notes.find((n) => n.id === id) ?? listed.templates.find((n) => n.id === id)
    if (!made) return
    const search = latestSearch.current
    if (search.query.trim()) {
      const found = await c.search(search.query, search.scope).catch(() => [])
      if (found.some((n) => n.id === id)) return
    } else {
      const view: ListView = inTrash
        ? { kind: 'trash' }
        : inTemplates
          ? { kind: 'templates' }
          : {
              kind: 'library',
              bookId: libraryBook?.id ?? null,
              filter: activeFilter,
            }
      if (viewLists(view, made, listed.books)) return
    }
    showLibrary(homeOf(made), { clearFilter: true })
  }

  /** The notebook a new note goes to: the one shown, else Settings > General's default. */
  const newNoteBookId = () =>
    notebookForNewNote(
      libraryBook?.id,
      editorSettings().defaultNotebook,
      books.map((b) => b.id),
    )

  const create = async () => {
    if (!core) return
    // Save pending titles first, so the refreshed list shows them.
    await saveEdits(core)
    // In Templates, a new note is a new template.
    const id = inTemplates ? await core.createTemplate() : await core.create('', newNoteBookId())
    if (!inTemplates) track('note.created', { from: 'new_note' })
    await showMade(core, id, await refresh(core))
    await select(id, { keyboard: true })
  }

  /**
   * Makes a note from a template and opens it; it goes to the notebook
   * shown unless the template names one, and shows in the list (see
   * `showMade`).
   */
  const createFromTemplate = async (templateId: string) => {
    setPicking(undefined)
    if (!core) return
    await saveEdits(core)
    const id = await core
      .applyTemplate(templateId, Date.now(), newNoteBookId())
      .catch(() => undefined)
    if (!id) return console.warn('W_TEMPLATE_APPLY_FAILED', templateId)
    recentTemplates.use(templateId)
    track('note.created', { from: 'template' })
    // Its body, status and tags are written before the lists reload.
    await saveEdits(core)
    await showMade(core, id, await refresh(core))
    await select(id, { keyboard: true })
  }

  /**
   * Fills the open note from a template (the empty note's "Choose a
   * template"): no new note is made. The open editor takes in what the core
   * wrote, the way it takes in another process's writes.
   */
  const fillFromTemplate = async (templateId: string, noteId: string) => {
    setPicking(undefined)
    if (!core) return
    await saveEdits(core)
    const navigation = opens.current
    const editor = editorRef.current?.noteId === noteId ? editorRef.current : null
    const done = await core
      .applyTemplateTo(templateId, noteId, Date.now())
      .then(() => true)
      .catch(() => false)
    if (!done) return console.warn('W_TEMPLATE_APPLY_FAILED', templateId)
    recentTemplates.use(templateId)
    if (opens.current === navigation && editor && editorRef.current === editor) {
      const opened = await core.open(noteId, editor.vector()).catch(() => undefined)
      // The user asked for the fill, so Cmd+Z takes it back.
      if (opened && editorRef.current === editor) editor.takeStep(opened.state)
      const filled = await core.title(noteId).catch(() => undefined)
      if (filled !== undefined && opens.current === navigation) setTitle(filled)
    }
    await saveEdits(core)
    await refresh(core)
  }

  /** Writes dates set on the preview's info card, then reloads the lists that show them. */
  const setNoteDates = useStable(
    async (id: string, dates: { createdAt?: number; updatedAt?: number }) => {
      if (!core) return
      await core.setNoteDates(id, dates)
      await refresh(core)
    },
  )

  /** Saves a copy of a built-in template as the user's own, shows it and opens it. */
  const editBuiltInCopy = async (id: string) => {
    if (!core) return
    await saveEdits(core)
    const copy = await core.saveTemplate(id, {}).catch(() => undefined)
    if (!copy) return console.warn('W_TEMPLATE_COPY_FAILED', id)
    setBuiltIn(undefined)
    await showMade(core, copy, await refresh(core))
    await select(copy, { keyboard: true })
  }
  const useBuiltIn = (id: string) => {
    setBuiltIn(undefined)
    return createFromTemplate(id)
  }
  const showBuiltIn = useStable((id: string) => {
    setSelected(undefined)
    setBuiltIn(id)
  })
  // A built-in template shows only in the Templates view, with no note open.
  const shownBuiltIn = selected === undefined && inTemplates ? builtIn : undefined

  /**
   * Copies a note (title with "copy" after it, body, notebook, status, tags;
   * see `duplicateNote`) and opens the copy, shown in the list (see `showMade`).
   */
  const duplicate = async (id: string) => {
    if (!core) return
    await saveEdits(core)
    const tagIds = [...notes, ...templates].find((n) => n.id === id)?.tagIds
    const copy = await core.duplicate(id, t('note.copySuffix'), tagIds).catch((e: unknown) => {
      console.warn('W_NOTE_DUPLICATE_FAILED', id, errorCode(e))
    })
    if (!copy) return
    // A template's copy is a template, not a note.
    if (!templates.some((n) => n.id === id)) track('note.created', { from: 'duplicate' })
    await showMade(core, copy, await refresh(core))
    await select(copy)
  }

  /**
   * Notes for the `[[` popup: search results, or the first notes of the list
   * for no query. It runs on every key, so it saves nothing (notes are found
   * as stored) and takes no more of the list than the popup shows.
   */
  const findLinkTargets = async (linkQuery: string) => {
    if (!core) return []
    const found = linkQuery
      ? await core.search(linkQuery, undefined, { flush: false })
      : await core.list(MAX_LINK_NOTES + 1)
    const targets = found.filter((n) => n.id !== selected)
    // The popup names an untitled note by its first line, as the list does.
    const named = await displayTitles(loadHeadlines, targets.slice(0, MAX_LINK_NOTES))
    return targets.map((n) => ({ ...n, title: named.get(n.id) ?? n.title }))
  }

  /**
   * New Note from Selection: the selected text becomes a note of its own
   * (titled after its first line, in the open note's notebook) and a link to
   * it takes its place, as one undo step. The open note stays open. When the
   * link cannot go in (the text was edited meanwhile, or another note was
   * opened), the new note is deleted again: the text is still where it was.
   */
  const noteFromSelection = async (sourceId: string) => {
    const editor = editorRef.current
    if (!core || !editor) return
    let made: string | undefined
    const moved = await editor.moveSelection(async (text) => {
      const note = await core.extract(sourceId, text).catch((e: unknown) => {
        console.warn('W_NOTE_EXTRACT_FAILED', sourceId, errorCode(e))
      })
      if (!note) return null
      made = note.id
      return noteLink(displayTitle(note.title, headline(text)), note.id)
    })
    if (made === undefined) return
    if (moved) {
      track('note.created', { from: 'selection' })
    } else {
      const dropped = made
      console.warn('W_NOTE_EXTRACT_NOT_LINKED', sourceId, dropped)
      await dropNote(core, dropped)
    }
    await refresh(core)
  }

  /** Deletes a note made for a link that could not go in, for good. */
  const dropNote = (c: Core, id: string) =>
    c
      .trash(id)
      .then(() => c.purge(id))
      .catch(() => console.warn('W_NOTE_DROP_FAILED', id))

  /** A note created from the `[[` popup; the open note stays open. */
  const createLinkedNote = async (linkTitle: string) => {
    if (!core) throw new Error('E_CORE_NOT_READY')
    const id = await core.create(linkTitle, newNoteBookId())
    await refresh(core)
    return id
  }

  /** A note from the `[[` popup could not be linked (see linkCompletion.ts): it goes again. */
  const discardLinkedNote = async (id: string) => {
    if (!core) return
    await dropNote(core, id)
    await refresh(core)
  }

  // A title being typed: the field shows it at once, the lists and search
  // results once typing pauses (see LIST_TITLE_MS).
  const typedTitle = useRef<{ id: string; title: string }>(undefined)
  const typedTitleTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const listTypedTitle = useCallback(() => {
    clearTimeout(typedTitleTimer.current)
    const typed = typedTitle.current
    typedTitle.current = undefined
    if (!typed) return
    setNotes((list) => retitled(list, typed.id, typed.title))
    setTemplates((list) => retitled(list, typed.id, typed.title))
    setResults((shown) => {
      const found = shown && retitled(shown.found, typed.id, typed.title)
      return shown && found !== shown.found ? { ...shown, found: found! } : shown
    })
  }, [])
  useEffect(() => () => clearTimeout(typedTitleTimer.current), [])
  const rename = (next: string) => {
    if (!core || !selected) return
    // One line, cut to the longest title storage takes, as the core does:
    // a long paste never stops the note from saving.
    const clean = clipTitle(next)
    setTitle(clean)
    // Another note's title still waiting goes to the lists now.
    if (typedTitle.current && typedTitle.current.id !== selected) listTypedTitle()
    typedTitle.current = { id: selected, title: clean }
    clearTimeout(typedTitleTimer.current)
    typedTitleTimer.current = setTimeout(listTypedTitle, LIST_TITLE_MS)
    void core.setTitle(selected, clean)
  }

  /**
   * Runs a notebook change, then reloads the lists; a refused change is
   * logged by code and shown in a notice (a name too long, a tag name taken).
   */
  const changeBooks = async (change: (c: Core) => Promise<unknown>) => {
    if (!core) return
    setChangeNotice(undefined)
    reloadsPending.current += 1
    try {
      await saveEdits(core)
      await change(core).catch((e: unknown) => {
        const code = errorCode(e)
        console.warn('W_BOOK_CHANGE_FAILED', code)
        setChangeNotice(code)
      })
      // Note changes save after a short delay; write them before reloading.
      await saveEdits(core)
      await refresh(core)
    } finally {
      reloadsPending.current -= 1
    }
  }

  const createBook = (parentId: string | null) =>
    changeBooks(async (c) => {
      const id = await c.createBook(t('book.new'), parentId)
      showLibraryRef.current?.({ kind: 'book', id })
      setRenamingBook(id)
    })

  // A deleted notebook drops out of `books`, so the library falls back to All Notes.
  const deleteBook = (id: string) => changeBooks((c) => c.removeBook(id))

  const moveNote = (noteId: string, bookId: string | null) =>
    changeBooks((c) => c.setBook(noteId, bookId))
  const setStatus = (noteId: string, status: NoteStatus) =>
    changeBooks((c) => c.setStatus(noteId, status))

  /**
   * One change to several notes, note by note (each with its own write and
   * HLC), then the lists reload. Notes that could not be changed are logged
   * by code and counted in a notice; the rest keep their change.
   */
  const runBatch = async (ids: readonly string[], change: BatchChange) => {
    if (!core || ids.length === 0) return
    setBatchFailed(undefined)
    reloadsPending.current += 1
    try {
      await saveEdits(core)
      const result = await core.batch([...ids], change).catch((e: unknown) => ({
        changed: [],
        failed: ids.map((id) => ({ id, code: errorCode(e) })),
      }))
      if (result.failed.length > 0) {
        console.warn('W_BATCH_FAILED', change.kind, result.failed.length, result.failed[0]?.code)
        setBatchFailed(result.failed.length)
      }
      await saveEdits(core)
      await refresh(core)
    } finally {
      reloadsPending.current -= 1
    }
  }
  // Every note named gets the write, even one that seems to have the value
  // already: the lists may not have caught up with a change just made (a
  // quick second P unpins again).
  const moveNotes = (ids: readonly string[], bookId: string | null) =>
    runBatch(ids, { kind: 'book', bookId })
  const setNotesStatus = (ids: readonly string[], status: NoteStatus) =>
    runBatch(ids, { kind: 'status', status })
  const setNotesPinned = (ids: readonly string[], pinned: boolean) =>
    runBatch(ids, { kind: 'pinned', pinned })
  // A name typed is found or made; a tag picked from a list goes on by ID,
  // so it is the one picked even when two tags share its name.
  const addTagToNotes = (ids: readonly string[], name: string) =>
    runBatch(ids, { kind: 'addTag', name })
  const putTagOnNotes = (ids: readonly string[], tagId: string) =>
    runBatch(ids, { kind: 'putTag', tagId })
  const removeTagFromNotes = (ids: readonly string[], tagId: string) =>
    runBatch(ids, { kind: 'removeTag', tagId })
  const trashNotes = async (ids: readonly string[]) => {
    await runBatch(ids, { kind: 'trash' })
    setSelected((open) => (open !== undefined && ids.includes(open) ? undefined : open))
    // Notes back from the Trash come back unselected.
    setMultiIn((m) => (m?.selection.ids.some((id) => ids.includes(id)) ? undefined : m))
  }
  const restoreNotes = async (ids: readonly string[]) => {
    await runBatch(ids, { kind: 'restore' })
    setSelected(undefined)
    setMulti(undefined)
  }
  /** Opens the Revision History sheet for a note (opening the note first). */
  const showHistory = async (id: string | undefined) => {
    if (!id || inTrash) return
    if (id !== selected) await select(id)
    setHistoryFor(id)
  }
  // The open note's history; none while several notes are selected.
  useHistoryMenu(() => void (multiIds === undefined && showHistory(selected)))
  // The sheet belongs to the open note: another note or the Trash closes it
  // for good (also when opening the note failed).
  if (historyFor !== undefined && (historyFor !== selected || inTrash)) {
    setHistoryFor(undefined)
  }
  const find = useFind({
    mode,
    noteOpen: !!core && selected !== undefined && !inTrash && !multiIds,
    editor: editorFind,
    preview: previewFind,
  })
  const listedNotes = useMemo(() => [...notes, ...templates], [notes, templates])
  /**
   * Runs an export, print or copy (exporter.ts, loaded on first use); a
   * failure shows what did not complete, with its code, in a notice.
   */
  const runExport = async (
    failure: ExportFailure,
    run: (exporter: typeof import('./exporter')) => Promise<void>,
  ) => {
    if (!core) return
    setExportNotice(undefined)
    try {
      await run(await import('./exporter'))
    } catch (error) {
      const code = errorCode(error)
      console.warn('W_EXPORT_FAILED', code)
      setExportNotice({ failure, code })
    }
  }
  const exportNote = (action: ExportAction, id: string) =>
    runExport(failureOf(action), (exporter) => exporter.runNoteExport(core!, action, id))
  const exportBook = (action: 'exportMarkdown' | 'exportHtml', id: string) =>
    runExport('export', (exporter) => exporter.runBookExport(core!, action, id))
  const exportNotes = (action: 'exportMarkdown' | 'exportHtml', ids: readonly string[]) =>
    runExport('export', (exporter) => exporter.runSelectionExport(core!, action, ids))
  const exportAll = (action: 'exportMarkdown' | 'exportHtml') =>
    runExport('export', (exporter) => exporter.runAllExport(core!, action))
  // File > Export > All Notes: Rust sends `markdown` or `html`.
  useMenuEvent('devot://export-all', EXPORT_ALL, (format) => {
    if (format === 'markdown') void exportAll('exportMarkdown')
    else if (format === 'html') void exportAll('exportHtml')
  })
  const noteActions = useNoteActions({
    headlines: loadHeadlines,
    notes: listedNotes,
    tree,
    tags,
    selection: inTrash ? undefined : multiIds,
    duplicate,
    history: showHistory,
    exportNote,
    exportNotes,
    copyFailed: (failure, code) => setExportNotice({ failure, code }),
    move: moveNotes,
    setPinned: setNotesPinned,
    setStatus: setNotesStatus,
    addTag: addTagToNotes,
    putTag: putTagOnNotes,
    removeTag: removeTagFromNotes,
    trash: trashNotes,
  })

  // Back and Forward: the trail entry each opens, skipping notes deleted
  // since (the Trash's notes are never entries). Templates are notes too:
  // they are entries like any other. The open note is the current entry's,
  // or the one a navigation is opening (`opening`); none in the Trash or
  // when it was deleted.
  const liveIds = useMemo(
    () => new Set([...notes, ...templates].map((n) => n.id)),
    [notes, templates],
  )
  const onTrail = (now: Trail, opening?: string) => ({
    live: (id: string) => liveIds.has(id),
    current: opening ?? (inTrash || selected === undefined ? undefined : now.ids[now.at]),
  })
  const backAt = stepTarget(trail, -1, onTrail(trail))
  const forwardAt = stepTarget(trail, 1, onTrail(trail))
  /** Goes back or forward; a key pressed in the editor leaves the keyboard there. */
  const step = (by: -1 | 1) => {
    const now = trailRef.current
    const at = stepTarget(now, by, onTrail(now, openingRef.current))
    const id = at === undefined ? undefined : now.ids[at]
    if (at === undefined || id === undefined) return
    moveTrail(trailTo(now, at))
    const keyboard = inEditor(document.activeElement)
    if (inTrash) showLibrary({ kind: 'all' })
    return select(id, { keyboard, fromTrail: true })
  }
  const nextId = adjacentNote(listedIds, selected, 1)
  const previousId = adjacentNote(listedIds, selected, -1)
  /**
   * Opens the next or previous note, after the one a navigation is opening
   * when one is; one opened from the editor takes the keyboard there.
   */
  const openListed = (by: -1 | 1) => {
    const id = adjacentNote(listedIds, openingRef.current ?? selected, by)
    if (id === undefined) return
    if (!inTrash) return select(id, { keyboard: inEditor(document.activeElement) })
    startOpening(id)
    setMulti(undefined)
    setSelected(id)
  }
  /**
   * Return or Cmd+Return on a list row: edit the open note's title or body
   * (opening the row's note first when none is open). The body shows the
   * editor in preview mode; an editor still loading takes the keyboard when
   * it has loaded.
   */
  const editNote = async (part: 'title' | 'body', id: string, start = false) => {
    const body = part === 'body'
    // Editing goes back to the open note alone.
    setMulti(undefined)
    if (id !== selected) {
      if (!(await select(id, { keyboard: body }))) return
    } else if (body && !editorRef.current) setTakesKeyboard(id)
    if (body && mode === 'preview') setMode('edit')
    requestFocus({ kind: part, id, start })
  }

  /**
   * The editor could not open its note (it is gone or in the Trash): the
   * note closes, so no editor shows with a stale title and an empty body.
   */
  const closeUnopenable = useStable((id: string, code: string) => {
    console.warn('W_NOTE_OPEN_FAILED', id, code)
    if (id === selected) setSelected(undefined)
  })

  /**
   * The list's selection changed (see listSelection.ts). One note left is
   * the open note on its own; with several, the open note stays open while
   * it is selected, else the anchor opens (see `openAfter`). Undefined
   * (Escape) goes back to the open note alone.
   */
  const changeSelection = (next: ListSelection | undefined) => {
    if (!next) return setMulti(undefined)
    const open = next.ids.length > 1 ? openAfter(next, selected) : next.ids[0]
    if (open === undefined) return
    // The editor gives way to the summary; when it comes back, the list
    // keeps the keyboard (a new note's editor took it only once).
    if (next.ids.length > 1) setTakesKeyboard(undefined)
    setMulti(next.ids.length > 1 ? next : undefined)
    if (open === selected) return
    if (!inTrash) return void select(open, { keepSelection: true })
    startOpening(open)
    setSelected(open)
  }

  /** Moves the keyboard to the next or previous area (see areas.ts). */
  const moveArea = (by: 1 | -1, from = areaOf(document.activeElement)) => {
    const targets = areaTargets(editorRef.current)
    const to = nextArea(from, by, (area) => targets[area] !== undefined)
    if (to) targets[to]?.()
  }
  usePaneTab(moveArea)
  // The keyboard never stays on the page when what had it goes away.
  useFocusRescue(() => editorRef.current)

  // Hiding or showing the sidebar. Focus mode hides it too, so showing it
  // leaves focus mode. When it hides with the keyboard, the list takes it;
  // shown from its Show Sidebar button (which goes away), the sidebar does.
  const sidebarKeyEcho = useRef(-Infinity)
  const toggleSidebar = () => {
    if (sidebarShown) {
      const hadKeyboard = areaOf(document.activeElement) === 'sidebar'
      // Shown on request in a narrow window: put away again, nothing stored.
      if (narrow && !sidebarHidden) setAskedIn(null)
      else {
        sidebarStore.save(true)
        setSidebarHidden(true)
      }
      if (hadKeyboard) requestFocus({ kind: 'area', area: 'list' })
      return
    }
    if (document.activeElement?.closest('.sidebar-show')) {
      requestFocus({ kind: 'area', area: 'sidebar' })
    }
    if (focus) {
      focusStore.save(false)
      setFocus(false)
    }
    sidebarStore.save(false)
    setSidebarHidden(false)
    setAskedIn(narrow)
  }
  useMenuEvent('devot://toggle-sidebar', TOGGLE_SIDEBAR, () => {
    const echo = performance.now() < sidebarKeyEcho.current
    sidebarKeyEcho.current = -Infinity
    if (!echo) toggleSidebar()
  })
  // The menu bar names what View > Hide Sidebar does now.
  useEffect(() => {
    invoke('sidebar_menu_set', { shown: sidebarShown }).catch(() =>
      console.warn('W_SIDEBAR_MENU_SET_FAILED'),
    )
  }, [sidebarShown])

  // A requested keyboard move, once the window has rendered what it needs:
  // an area, or a note's title or body once that note is open (an editor
  // still loading takes the keyboard itself, see `editNote`).
  useEffect(() => {
    const request = focusAfter.current
    if (!request) return
    if (request.kind === 'area') {
      const go = areaTargets(editorRef.current)[request.area]
      // The area may show on a pass of its own (a sidebar the same click
      // shows): the ask stays for the passes of the next second.
      if (!go && performance.now() - focusAskedAt.current < AREA_ASK_MS) return
      focusAfter.current = undefined
      return go?.()
    }
    // The note opened before the request was made; another one opened since.
    focusAfter.current = undefined
    if (request.id !== selected) return
    if (request.kind === 'body') {
      return request.start ? editorRef.current?.focusStart() : editorRef.current?.focus()
    }
    const field = titleRef.current
    field?.focus()
    field?.setSelectionRange(field.value.length, field.value.length)
  })

  const openPalette = (scope?: PaletteSource) => {
    if (sheetOpen()) return
    const element = document.activeElement
    paletteReturn.current = {
      editor: inEditor(element),
      element: element instanceof HTMLElement ? element : null,
    }
    setPaletteInTable(editorRef.current?.inTable() ?? false)
    setPaletteSelection(editorRef.current?.hasSelection() ?? false)
    setPaletteImage(editorRef.current?.imageAtCursor() ?? null)
    setPaletteText(editorRef.current?.text() ?? '')
    setPaletteScope(scope)
    setPaletteOpen(true)
  }
  /**
   * Gives the keyboard back where it was, then runs the picked action
   * (`picked`), if any. Once the action is done (a note it opens is open, a
   * note it trashes is gone) and rendered, the effect below checks the
   * keyboard is still somewhere visible.
   */
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
  // The action may have hidden or removed what had the keyboard (Show
  // Preview hides the editor, focus mode the list, Move to Trash and opening
  // another note replace the editor): then the open note's row (or the
  // list's first), its editor, its title, or a toolbar button takes it. A
  // note opened from the editor takes it back into its own editor once that
  // has loaded (see `takesKeyboard`).
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
  }, [paletteDone])
  useMenuEvent('devot://show-palette', SHOW_PALETTE, () => openPalette())

  // Cmd+E: editor and preview swap; from split, the pane that has the
  // keyboard is the one that stays.
  const previewKeyEcho = useRef(-Infinity)
  const togglePreview = () => {
    const from = document.activeElement
    setMode((m) => {
      if (m === 'edit') return 'preview'
      if (m === 'preview') return 'edit'
      return from?.closest('.preview') ? 'preview' : 'edit'
    })
  }
  useMenuEvent('devot://toggle-preview', TOGGLE_PREVIEW, () => {
    // The key reaches the menu too; the window already ran the command.
    if (performance.now() >= previewKeyEcho.current) togglePreview()
  })
  useMenuEvent('devot://show-split', SHOW_SPLIT, () => setMode('split'))

  // Every command this window can run now, by registry ID: the window keys,
  // the palette and the native menu run them.
  const openNote = selected !== undefined && !inTrash && !multiIds ? selectedNote : undefined
  const handlers: CommandHandlers = {
    'palette.open': { run: () => openPalette() },
    'search.view': { run: () => startSearch('view') },
    'search.all': { run: () => startSearch('all') },
    'view.focus': { run: toggleFocus },
    'view.sidebar': {
      run: () => {
        sidebarKeyEcho.current = performance.now() + MENU_ECHO_MS
        toggleSidebar()
      },
      label: sidebarShown ? 'command.hideSidebar' : 'command.showSidebar',
    },
    'view.focusNoteList': { run: () => requestFocus({ kind: 'area', area: 'list' }) },
    'view.nextSidebarRow': { run: () => stepSidebarRow(1) },
    'view.previousSidebarRow': { run: () => stepSidebarRow(-1) },
    'view.nextArea': { run: () => moveArea(1) },
    'view.previousArea': { run: () => moveArea(-1) },
    'view.fontBigger': { run: () => stepEditorFontSize(1) },
    'view.fontSmaller': { run: () => stepEditorFontSize(-1) },
    'view.fontReset': { run: () => stepEditorFontSize(0) },
    'view.syncScroll': {
      run: () =>
        changeEditorSettings({
          syncScroll: !editorSettings().syncScroll,
        }).catch(() => console.warn('W_EDITOR_SETTINGS_SAVE_FAILED')),
      label: syncScroll ? 'command.syncScrollOff' : 'command.syncScrollOn',
    },
    'view.allNotes': { run: () => showLibrary({ kind: 'all' }) },
    'view.templates': { run: () => showLibrary({ kind: 'templates' }) },
    'view.trash': { run: () => showLibrary({ kind: 'trash' }) },
    'app.backups': { run: showBackups },
    'app.exportAllMarkdown': { run: () => exportAll('exportMarkdown') },
    'app.exportAllHtml': { run: () => exportAll('exportHtml') },
    'mirror.chooseFolder': { run: mirror.choose },
  }
  if (mirror.status.folder !== null) handlers['mirror.turnOff'] = { run: mirror.turnOff }
  // Sort Notes… opens the sort pop-up under the list's button.
  if (!focus && !inTrash) {
    handlers['view.sort'] = {
      run: () => {
        const anchor = sortButtonRef.current
        if (visible(anchor)) return listOrder.show(anchor)
      },
    }
  }
  if (trash.length > 0) handlers['trash.empty'] = { run: () => setConfirm({ kind: 'empty' }) }
  if (inTrash && selected !== undefined && trash.some((n) => n.id === selected) && !multiIds) {
    const id = selected
    for (const [action, commandId] of Object.entries(TRASH_COMMANDS)) {
      handlers[commandId] = {
        run: () => trashAction(action as TrashAction, id),
      }
    }
  }
  // Several notes selected: the note commands act on all of them.
  if (multiIds && inTrash) {
    const ids = multiIds
    handlers['trash.restore'] = {
      run: () => restoreNotes(ids),
      label: 'batch.restore',
    }
    handlers['trash.deleteForever'] = {
      run: () => confirmDeleteMany(ids),
      label: 'batch.deleteForever',
    }
  } else if (multiIds) {
    const ids = multiIds
    const run = (action: NoteMenuAction) => () => noteActions.runOn(action, ids)
    handlers['note.move'] = { run: run('move'), label: 'batch.move' }
    handlers['note.pin'] = {
      run: run('pin'),
      label: selectedNotes.every((n) => n.pinned) ? 'batch.unpin' : 'batch.pin',
    }
    handlers['note.copyLink'] = {
      run: run('copyLink'),
      label: 'batch.copyLinks',
    }
    handlers['note.trash'] = { run: run('trash'), label: 'batch.trash' }
    if (!inTemplates) {
      for (const [status, commandId] of Object.entries(STATUS_COMMANDS)) {
        handlers[commandId] = {
          run: () => setNotesStatus(ids, status as NoteStatus),
        }
      }
      handlers['note.addTag'] = { run: run('addTag') }
      if (selectedNotes.some((n) => n.tagIds.length > 0)) {
        handlers['note.removeTag'] = { run: run('removeTag') }
      }
    }
  }
  // Select All Notes (Cmd+A in a list): every note the list shows.
  if (!focus && listedIds.length > 1) {
    handlers['list.selectAll'] = {
      run: () => changeSelection(selectAll(shownSelection, selected, listedIds)),
    }
  }
  if (core) {
    handlers['note.new'] = {
      run: () => {
        // A new note goes to the library, not the Trash.
        if (inTrash) showLibrary({ kind: 'all' })
        return create()
      },
    }
    handlers['notebook.new'] = { run: () => createBook(null) }
    if (backAt !== undefined) handlers['note.back'] = { run: () => step(-1) }
    if (forwardAt !== undefined) handlers['note.forward'] = { run: () => step(1) }
    if (nextId !== undefined) handlers['note.next'] = { run: () => openListed(1) }
    if (previousId !== undefined) handlers['note.previous'] = { run: () => openListed(-1) }
    handlers['note.newFromTemplate'] = {
      run: () => setPicking({ recent: recentTemplates.load() }),
    }
  }
  if (openNote) {
    const id = openNote.id
    for (const [action, commandId] of Object.entries(NOTE_COMMANDS)) {
      if (SELECTION_ONLY.has(action as NoteAction)) continue
      handlers[commandId] = {
        run: () => noteActions.run(action as NoteAction, id),
      }
    }
    handlers['note.pin'] = {
      run: () => noteActions.run('pin', id),
      label: openNote.pinned ? 'note.unpin' : 'note.pin',
    }
    // Control+Command+1 to 5 set the open note's status. A template's own
    // status is not shown and not used (its front matter sets one).
    if (!selectedIsTemplate) {
      for (const [status, commandId] of Object.entries(STATUS_COMMANDS)) {
        handlers[commandId] = {
          run: () => setStatus(id, status as NoteStatus),
        }
      }
    }
    handlers['view.edit'] = { run: () => setMode('edit') }
    handlers['view.togglePreview'] = {
      run: () => {
        previewKeyEcho.current = performance.now() + MENU_ECHO_MS
        togglePreview()
      },
    }
    handlers['view.split'] = { run: () => setMode('split') }
    handlers['view.preview'] = { run: () => setMode('preview') }
    if (mode !== 'preview') {
      for (const c of COMMANDS) {
        const formatId = formatOf(c.id)
        if (formatId) handlers[c.id] = { run: () => editorRef.current?.format(formatId) }
        const insertId = insertOf(c.id)
        if (insertId) handlers[c.id] = { run: () => editorRef.current?.insert(insertId) }
        const tableId = paletteOpen && paletteInTable ? tableOf(c.id) : undefined
        if (tableId) handlers[c.id] = { run: () => editorRef.current?.table(tableId) }
      }
      handlers['edit.pastePlain'] = {
        run: () => editorRef.current?.pastePlain(),
      }
      if (paletteOpen && paletteSelection) {
        handlers['note.newFromSelection'] = {
          run: () => noteFromSelection(id),
        }
      }
      const image = paletteOpen ? paletteImage : null
      if (image?.fileId)
        handlers['image.view'] = {
          run: () => void editorRef.current?.viewImage(),
        }
      if (image) {
        for (const [action, commandId] of Object.entries(IMAGE_COMMANDS)) {
          if (!imageActionApplies(action as ImageAction, image)) continue
          handlers[commandId] = {
            run: () => runImageAction(action as ImageAction, image, setImageSize),
          }
        }
      }
    }
  }
  // Find works while a note is open; its keys run ahead of the editor's (useFind).
  Object.assign(handlers, find.commands)
  // Move to Notebook from anywhere runs what the list's key does.
  if (handlers['note.move']) handlers['note.moveAnywhere'] = handlers['note.move']
  useWindowCommands(handlers)
  // The menu bar's Format menu runs the format commands too.
  useFormatMenu(handlers)
  useCommandMenu()

  // What the palette lists. Notebooks, tags and notes are only gathered
  // while it is open, and again only when they change.
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

  /** What Return, Shift+Return and Command+Return do on a palette result. */
  const paletteActions = (entry: PaletteEntry): PaletteActions => {
    switch (entry.kind) {
      case 'source':
        // The palette opens a source itself.
        return { primary: { label: t('palette.openSource'), run: () => undefined } }
      case 'command': {
        const handler = handlers[entry.id as keyof CommandHandlers]
        return {
          primary: { label: t('palette.run'), run: () => handler?.run() },
        }
      }
      case 'book':
        return {
          primary: {
            label: t('palette.openNotebook'),
            run: () => showLibrary({ kind: 'book', id: entry.id }),
          },
          shift:
            openNote && openNote.bookId !== entry.id
              ? {
                  label: t('palette.moveNoteHere'),
                  run: () => moveNote(openNote.id, entry.id),
                }
              : undefined,
        }
      case 'tag':
        return {
          primary: {
            label: t('palette.showTag'),
            run: () => showFilter({ kind: 'tag', tagId: entry.id }),
          },
          meta: {
            label: t('palette.addToFilter'),
            run: () => changeQuery(withTagClause(query, entry.label)),
          },
          shift:
            openNote && !selectedIsTemplate && !openNote.tagIds.includes(entry.id)
              ? {
                  label: t('palette.addTagToNote'),
                  run: () => putTagOnNotes([openNote.id], entry.id),
                }
              : undefined,
        }
      case 'outline':
        return {
          primary: {
            label: t('palette.goToLine'),
            run: () => editorRef.current?.goToLine(entry.line ?? 1),
          },
        }
      case 'note':
        return {
          primary: {
            label: t('palette.open'),
            run: () => {
              // Notes listed are live: leave the Trash to show one. The open
              // note stays as it is.
              if (inTrash) showLibrary({ kind: 'all' })
              else if (entry.id === selected) return
              return select(entry.id)
            },
          },
        }
    }
  }

  // What the note list and the sidebar get, kept the same from render to
  // render while it does not change: both are memoized, so typing in a note,
  // or anything else they do not show, renders neither of them.
  const toggleSidebarNow = useStable(toggleSidebar)
  // While the sidebar is hidden (not in focus mode), the list's toolbar
  // shows it again.
  const showSidebarButton = useMemo(
    () => (sidebarOff && !focus ? <ShowSidebarButton onClick={toggleSidebarNow} /> : null),
    [sidebarOff, focus, toggleSidebarNow],
  )
  // The Filter field under the list's header: the search, scoped to the view.
  const changeQueryStable = useStable((next: string) => changeQuery(next))
  const clearSearchStable = useStable(() => clearSearch())
  const filterField = useMemo(
    () => (
      <SearchField
        ref={searchField}
        value={query}
        onChange={changeQueryStable}
        onClear={clearSearchStable}
        placeholder={inView ? t('filter.placeholder') : t('search.placeholder')}
      />
    ),
    [query, inView, changeQueryStable, clearSearchStable],
  )
  const openFromList = useStable((id: string) => void select(id))
  const createFromList = useStable(() => void create())
  const runNoteAction = useStable((action: NoteAction, id: string) => noteActions.run(action, id))
  const showNoteMenu = useStable((id: string) => noteActions.menu(id))
  const findInView = useStable(() => startSearch('view'))
  const findEverywhere = useStable(() => startSearch('all'))
  const findAgain = useStable(() => startSearch(searchIn))
  const editFromList = useStable((part: 'title' | 'body', id: string) => void editNote(part, id))
  const changeListSelection = useStable(changeSelection)
  const openTrashed = useStable((id: string) => {
    setMulti(undefined)
    setSelected(id)
  })
  const trashKey = useStable((action: TrashAction, id: string) => void trashAction(action, id))
  const askEmptyTrash = useStable(() => {
    if (trash.length > 0) setConfirm({ kind: 'empty' })
  })
  // aria-disabled, not disabled: a disabled button would drop the keyboard
  // when the Trash is emptied from it.
  const showTrashMenu = useTrashMenu((action, target) => void trashAction(action, target.id))
  const trashRowMenu = useStable(
    (id: string) => void showTrashMenu({ id, count: multiIds?.includes(id) ? multiIds.length : 1 }),
  )
  const emptyTrashButton = useMemo(
    () => (
      <button
        type="button"
        className="button"
        aria-disabled={trash.length === 0}
        onClick={askEmptyTrash}
      >
        {t('trash.empty')}
      </button>
    ),
    [trash.length, askEmptyTrash],
  )
  const sidebarSelect = useStable((next: Selection, options?: { clearFilter?: boolean }) =>
    showLibrary(next, options),
  )
  const sidebarCreateBook = useStable((parentId: string | null) => void createBook(parentId))
  const sidebarRenameBook = useStable(
    (id: string, name: string) => void changeBooks((c) => c.renameBook(id, name)),
  )
  const sidebarRenameDone = useStable(() => setRenamingBook(undefined))
  const sidebarMoveBook = useStable(
    (id: string, parentId: string | null) => void changeBooks((c) => c.moveBook(id, parentId)),
  )
  const sidebarPlaceBook = useStable(
    (id: string, targetId: string, where: 'before' | 'after') =>
      void changeBooks((c) => c.placeBook(id, targetId, where)),
  )
  const sidebarSetAiAccess = useStable(
    (id: string, on: boolean) => void changeBooks((c) => c.setBookAiAccess(id, on)),
  )
  // Deleting a notebook asks first: it takes its sub-notebooks with it, and
  // nothing brings them back.
  const sidebarDeleteBook = useStable((id: string) => {
    const book = books.find((b) => b.id === id)
    if (!book) return
    setConfirm({
      kind: 'book',
      id,
      name: book.name,
      subs: bookWithDescendants(books, id).size - 1,
      notes: counts.get(id) ?? 0,
    })
  })
  const sidebarExportBook = useStable(
    (action: 'exportMarkdown' | 'exportHtml', id: string) => void exportBook(action, id),
  )
  const sidebarImportBook = useStable((action: ImportAction, id: string) => {
    const kind = IMPORT_PICKS[action]
    // A failure shows in the import sheet, as one from File > Import does.
    pickImport(kind, id).catch((e: unknown) => {
      const code = errorCode(e)
      console.warn('W_IMPORT_PICK_FAILED', code)
      window.dispatchEvent(new CustomEvent(IMPORT_FAILED, { detail: { id: null, code } }))
    })
  })
  const sidebarMoveNotes = useStable((ids: string[], bookId: string) => void moveNotes(ids, bookId))
  const sidebarTagNotes = useStable(
    (ids: string[], tagId: string) => void putTagOnNotes(ids, tagId),
  )
  const sidebarSetNotesStatus = useStable(
    (ids: string[], status: NoteStatus) => void setNotesStatus(ids, status),
  )
  const sidebarTrashNotes = useStable((ids: string[]) => void trashNotes(ids))
  const sidebarFilter = useStable((next: NoteFilter | null) => showFilter(next))
  const sidebarRenameTag = useStable(
    (id: string, name: string) => void changeBooks((c) => c.renameTag(id, name)),
  )
  const sidebarSetTagColor = useStable(
    (id: string, color: TagColor | null) => void changeBooks((c) => c.setTagColor(id, color)),
  )
  const sidebarSearchBooks = useStable(() => openPalette('book'))
  const sidebarSearchTags = useStable(() => openPalette('tag'))
  const sidebarNewNote = useStable(() => {
    // As New Note does: a new note goes to the library, not the Trash.
    if (inTrash) showLibrary({ kind: 'all' })
    void create()
  })
  const sidebarDeleteTag = useStable((id: string) =>
    setConfirm({
      kind: 'tag',
      id,
      name: tags.find((tag) => tag.id === id)?.name ?? '',
      count: tagged.get(id) ?? 0,
    }),
  )

  if (startFailure) return <StartFailure code={startFailure} onRetry={retryStart} />

  return (
    <div
      className="window"
      data-focus={focus || undefined}
      data-ready={restored || undefined}
      data-sidebar-hidden={sidebarOff || undefined}
      data-narrow={narrow || undefined}
      data-pane-motion={paneMotion || undefined}
    >
      <ToolTips />
      <Sidebar
        total={notes.length}
        tree={tree}
        counts={counts}
        selection={
          searchingAll ? null : libraryBook || inTrash || inTemplates ? library : ALL_NOTES
        }
        renaming={renamingBook}
        onSelect={sidebarSelect}
        onCreateBook={core ? sidebarCreateBook : undefined}
        onRenameBook={sidebarRenameBook}
        onRenameDone={sidebarRenameDone}
        onMoveBook={sidebarMoveBook}
        onPlaceBook={sidebarPlaceBook}
        onSetAiAccess={sidebarSetAiAccess}
        onDeleteBook={sidebarDeleteBook}
        onExportBook={sidebarExportBook}
        onImportBook={sidebarImportBook}
        onMoveNotes={sidebarMoveNotes}
        onTagNotes={sidebarTagNotes}
        onSetNotesStatus={sidebarSetNotesStatus}
        onTrashNotes={sidebarTrashNotes}
        filter={inTrash || inTemplates || searchingAll ? null : activeFilter}
        onFilter={sidebarFilter}
        pinnedCount={pinnedCount}
        statusCounts={statuses}
        tags={tags}
        tagCounts={tagged}
        onRenameTag={sidebarRenameTag}
        onSetTagColor={sidebarSetTagColor}
        onDeleteTag={sidebarDeleteTag}
        templatesCount={templates.length}
        trashCount={trash.length}
        onHide={toggleSidebarNow}
        onSearchBooks={sidebarSearchBooks}
        onSearchTags={sidebarSearchTags}
        onEmptyTrash={askEmptyTrash}
        onNewNote={core ? sidebarNewNote : undefined}
      />
      {searching ? (
        <NoteList
          view={listView}
          title={t('search.results')}
          icon="search"
          filter={filterField}
          scope={results?.search.scope ? format(t('search.in'), { view: viewName }) : undefined}
          highlight={highlight}
          onFind={findAgain}
          empty="search"
          pinned={NO_NOTES}
          notes={shownResults}
          tags={tagsById}
          selected={selected}
          onSelect={openFromList}
          onCreate={core ? createFromList : undefined}
          onAction={runNoteAction}
          onMenu={showNoteMenu}
          sort={sortButton}
          sortButtonRef={sortButtonRef}
          onEdit={editFromList}
          leading={showSidebarButton}
          selection={shownSelection}
          onSelection={changeListSelection}
          headlines={loadHeadlines}
          excerpts={loadExcerpts}
          progress={loadProgress}
        />
      ) : inTrash ? (
        <NoteList
          view={listView}
          title={t('sidebar.trash')}
          icon="trash"
          empty="trash"
          filter={filterField}
          pinned={NO_NOTES}
          notes={trashRows}
          tags={NO_TAGS}
          selected={selected}
          onSelect={openTrashed}
          onCreate={undefined}
          selection={shownSelection}
          onSelection={changeListSelection}
          headlines={loadHeadlines}
          excerpts={loadExcerpts}
          progress={loadProgress}
          drag={false}
          onFind={findEverywhere}
          onTrashAction={trashKey}
          onMenu={trashRowMenu}
          leading={showSidebarButton}
          headerAction={emptyTrashButton}
        />
      ) : inTemplates ? (
        <NoteList
          view={listView}
          title={t('sidebar.templates')}
          icon="templates"
          empty="templates"
          filter={filterField}
          pinned={templateRows.pinned}
          notes={templateRows.others}
          tags={tagsById}
          selected={selected}
          onSelect={openFromList}
          onCreate={core ? createFromList : undefined}
          createLabel={t('templates.new')}
          onAction={runNoteAction}
          onMenu={showNoteMenu}
          sort={sortButton}
          sortButtonRef={sortButtonRef}
          onFind={findEverywhere}
          onEdit={editFromList}
          leading={showSidebarButton}
          selection={shownSelection}
          onSelection={changeListSelection}
          headlines={loadHeadlines}
          excerpts={loadExcerpts}
          progress={loadProgress}
          drag="templates"
          after={<BuiltInTemplates selected={shownBuiltIn} onSelect={showBuiltIn} />}
        />
      ) : (
        <NoteList
          view={listView}
          title={filterLabel ?? libraryBook?.name ?? t('sidebar.allNotes')}
          icon={
            libraryBook
              ? 'notebook'
              : activeFilter?.kind === 'pinned'
                ? 'notes.pinned'
                : activeFilter
                  ? 'tag'
                  : 'notes.all'
          }
          empty={activeFilter ? 'filter' : libraryBook ? 'notebook' : 'all'}
          filter={filterField}
          scope={filterLabel !== undefined ? libraryBook?.name : undefined}
          pinned={activeFilter?.kind === 'pinned' ? NO_NOTES : groups.pinned}
          notes={activeFilter?.kind === 'pinned' ? groups.pinned : groups.others}
          tags={tagsById}
          selected={selected}
          onSelect={openFromList}
          onCreate={core ? createFromList : undefined}
          onAction={runNoteAction}
          onMenu={showNoteMenu}
          sort={sortButton}
          sortButtonRef={sortButtonRef}
          onFind={findInView}
          onEdit={editFromList}
          leading={showSidebarButton}
          selection={shownSelection}
          onSelection={changeListSelection}
          headlines={loadHeadlines}
          excerpts={loadExcerpts}
          progress={loadProgress}
        />
      )}
      <main className="content" data-devot-part="editor">
        <div className="toolbar editor-toolbar" data-devot-part="toolbar" data-tauri-drag-region>
          <div className="trail-buttons" data-tauri-drag-region>
            <button
              type="button"
              className="tool"
              aria-label={t('mode.focus')}
              title={titleWithKey('mode.focusTitle', 'view.focus')}
              aria-pressed={focus}
              onClick={toggleFocus}
            >
              <Icon name={focus ? 'mode.focus.exit' : 'mode.focus'} size="lg" />
            </button>
            <button
              type="button"
              className="tool"
              aria-label={t('command.back')}
              title={titleWithKey('command.backTitle', 'note.back')}
              disabled={backAt === undefined}
              onClick={() => void step(-1)}
            >
              <Icon name="nav.back" size="lg" />
            </button>
            <button
              type="button"
              className="tool"
              aria-label={t('command.forward')}
              title={titleWithKey('command.forwardTitle', 'note.forward')}
              disabled={forwardAt === undefined}
              onClick={() => void step(1)}
            >
              <Icon name="nav.forward" size="lg" />
            </button>
          </div>
          {selected && !inTrash && !multiIds ? (
            <>
              <ModeControl mode={mode} onChange={setMode} />
              <button
                type="button"
                className="tool note-more"
                aria-label={t('note.more')}
                title={t('note.more')}
                aria-haspopup="menu"
                onClick={(e) => {
                  const box = e.currentTarget.getBoundingClientRect()
                  noteActions.menuAt(selected, { x: box.left, y: box.bottom })
                }}
              >
                <Icon name="more.vertical" size="lg" />
              </button>
            </>
          ) : null}
        </div>
        {multiIds ? (
          <SelectionSummary
            notes={selectedNotes}
            view={inTrash ? 'trash' : inTemplates ? 'templates' : 'notes'}
            tags={tags}
            headlines={loadHeadlines}
            onMove={() => void noteActions.runOn('move', multiIds)}
            onPin={(pinned) => void setNotesPinned(multiIds, pinned)}
            onStatus={(status) => void setNotesStatus(multiIds, status)}
            onAddTag={(name) => void addTagToNotes(multiIds, name)}
            onRemoveTag={(tagId) => void removeTagFromNotes(multiIds, tagId)}
            onCopyLinks={() => void noteActions.runOn('copyLink', multiIds)}
            onTrash={() => void trashNotes(multiIds)}
            onRestore={() => void restoreNotes(multiIds)}
            onDelete={() => confirmDeleteMany(multiIds)}
          />
        ) : null}
        {core && selected && inTrash && !multiIds ? (
          <TrashView
            key={selected}
            core={core}
            noteId={selected}
            onRestore={() => void restoreTrashed(selected)}
            onDelete={(name) => setConfirm({ kind: 'one', id: selected, title: name })}
          />
        ) : null}
        {core && selected && !inTrash && !multiIds ? (
          <>
            <input
              ref={titleRef}
              className="title"
              aria-label={t('note.titleLabel')}
              placeholder={t('note.untitled')}
              value={title}
              onChange={(e) => rename(e.target.value)}
              onKeyDown={(e) => {
                // Return finishes the title and goes on to the tags (the body,
                // for a template); Down Arrow goes to the start of the body.
                // Not the keys that pick a candidate of an input method.
                if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
                if (isImeKey(e.nativeEvent)) return
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  return void editNote('body', selected, true)
                }
                if (e.key !== 'Enter') return
                e.preventDefault()
                const tagField = tagInputRef.current
                if (tagField && !selectedIsTemplate) return tagField.focus()
                void editNote('body', selected)
              }}
            />
            {selectedIsTemplate ? (
              <p className="note-meta template-hint">{t('templates.editorHint')}</p>
            ) : (
              <div className="note-meta">
                <BookPicker
                  tree={tree}
                  value={selectedNote?.bookId ?? null}
                  onChange={(bookId) => void moveNote(selected, bookId)}
                />
                <StatusPicker
                  value={selectedNote?.status ?? 'none'}
                  onChange={(status) => void setStatus(selected, status)}
                />
                <TagEditor
                  inputRef={tagInputRef}
                  tags={tags}
                  value={selectedNote?.tagIds ?? []}
                  onAdd={(name) => void changeBooks((c) => c.addTag(selected, name))}
                  onRemove={(tagId) => void changeBooks((c) => c.removeTag(selected, tagId))}
                />
              </div>
            )}
            {find.bar}
            <div className={`panes panes-${mode}`}>
              <NoteEditor
                key={selected}
                core={core}
                noteId={selected}
                autoFocus={selected === takesKeyboard}
                autoFocusIfFree={selected === restoreKeyboard.current}
                hidden={mode === 'preview'}
                onText={openText.set}
                links={{
                  find: findLinkTargets,
                  create: createLinkedNote,
                  discard: discardLinkedNote,
                  linked: () => track('note.created', { from: 'link' }),
                }}
                restoreRef={restoreRef}
                onFind={setEditorFind}
                onScrollPane={setEditorPane}
                showAlertMenu={showAlertMenu}
                handleRef={editorRef}
                onOpenImage={setViewing}
                showImageMenu={showImageMenu}
                initialPlace={takeEditorPlace(selected)}
                onPlace={editorPlaced}
                onNewFromSelection={inTrash ? undefined : () => void noteFromSelection(selected)}
                onImagesRefused={setImageNotice}
                onOpenFailed={closeUnopenable}
                onChooseTemplate={() =>
                  setPicking({ recent: recentTemplates.load(), into: selected })
                }
                onOpenNote={(id) => void select(id)}
              />
              {mode === 'edit' ? null : (
                <LivePreview
                  core={core}
                  text={openText}
                  info={
                    selectedNote
                      ? {
                          noteId: selectedNote.id,
                          createdAt: selectedNote.createdAt,
                          updatedAt: selectedNote.updatedAt,
                        }
                      : undefined
                  }
                  onSetDates={inTrash || !core ? undefined : setNoteDates}
                  onOpenNote={(id) => void select(id)}
                  onFind={setPreviewFind}
                  onScrollPane={setPreviewPane}
                  onOpenImage={setViewing}
                  onImageMenu={showImageMenu}
                  onToggleTask={(at) => void editorRef.current?.toggleTask(at)}
                  initialScroll={takePreviewScroll}
                  onScroll={previewScrolled}
                />
              )}
            </div>
          </>
        ) : shownBuiltIn ? (
          <BuiltInTemplate
            id={shownBuiltIn}
            onUse={(id) => void useBuiltIn(id)}
            onEditCopy={(id) => void editBuiltInCopy(id)}
          />
        ) : null}
      </main>
      {importJob ? (
        <ImportDialog
          key={importKey}
          job={importJob}
          tree={tree}
          initialDestination={library.kind === 'book' ? library.id : null}
          onImport={startImport}
          onClose={closeImport}
        />
      ) : null}
      {backupsOpen ? <BackupsDialog onRestore={restore} onClose={closeBackups} /> : null}
      {(backupNotice && !backupsOpen) ||
      exportNotice ||
      changeNotice ||
      batchFailed ||
      coreFailure ||
      imageNotice ||
      saveNoticeShown ||
      mirror.notices.length > 0 ? (
        // One corner for every notice, stacked, so none covers another.
        <div className="notices">
          {saveNoticeShown ? (
            <SaveNotice
              problems={saveProblems}
              quitHeld={quitHeld}
              onRetry={() => void (core && saveEdits(core))}
              onDismiss={() => setSaveNoticeDismissed(true)}
            />
          ) : null}
          {backupNotice && !backupsOpen ? (
            <BackupNotice
              code={backupNotice}
              onShow={() => {
                setBackupNotice(undefined)
                showBackups()
              }}
              onDismiss={() => setBackupNotice(undefined)}
            />
          ) : null}
          {exportNotice ? (
            <ExportNotice
              failure={exportNotice.failure}
              code={exportNotice.code}
              onDismiss={() => setExportNotice(undefined)}
            />
          ) : null}
          {mirror.notices}
          {changeNotice ? (
            <ChangeNotice code={changeNotice} onDismiss={() => setChangeNotice(undefined)} />
          ) : null}
          {batchFailed ? (
            <BatchNotice failed={batchFailed} onDismiss={() => setBatchFailed(undefined)} />
          ) : null}
          {coreFailure ? (
            <CoreNotice code={coreFailure} onDismiss={() => setCoreFailure(undefined)} />
          ) : null}
          {imageNotice ? (
            <ImageNotice codes={imageNotice} onDismiss={() => setImageNotice(undefined)} />
          ) : null}
        </div>
      ) : null}
      {mirror.dialog}
      {noteActions.dialog}
      {core && picking ? (
        <TemplatePicker
          core={core}
          templates={templates}
          headlines={loadHeadlines}
          recent={picking.recent}
          books={books}
          bookId={libraryBook?.id ?? null}
          locales={locales}
          intoOpenNote={picking.into !== undefined}
          onCreate={(id) =>
            void (picking.into === undefined
              ? createFromTemplate(id)
              : fillFromTemplate(id, picking.into))
          }
          onCancel={() => setPicking(undefined)}
        />
      ) : null}
      {paletteOpen ? (
        <CommandPalette
          entries={{
            command: commandEntries(handlers, t),
            source: sourceEntries(t),
            outline: outlineEntries(paletteText),
            ...(paletteLibrary ?? NO_LIBRARY),
          }}
          actions={paletteActions}
          initialScope={paletteScope}
          onClose={closePalette}
        />
      ) : null}
      {core && historyFor && historyFor === selected && !inTrash ? (
        <RevisionHistory
          core={core}
          noteId={historyFor}
          title={title}
          books={books}
          onRestore={(update) => {
            restoreRef.current?.(update)
            setHistoryFor(undefined)
          }}
          onClose={() => setHistoryFor(undefined)}
        />
      ) : null}
      {viewing ? <ImageViewer image={viewing} onClose={() => setViewing(null)} /> : null}
      {core && activityOpen ? (
        <Activity core={core} onClose={() => setActivityOpen(false)} />
      ) : null}
      {confirm?.kind === 'tag' ? (
        <ConfirmDialog
          message={format(t('tag.confirmDelete'), { name: confirm.name })}
          detail={format(t('tag.deleteDetail'), {
            notes: noteCount(confirm.count, currentLocale()),
          })}
          confirm={t('tagMenu.delete')}
          onConfirm={() => void runConfirmed()}
          onCancel={() => setConfirm(undefined)}
        />
      ) : confirm?.kind === 'book' ? (
        <ConfirmDialog
          message={format(t('book.confirmDelete'), { name: confirm.name })}
          detail={bookDeleteDetail(confirm.subs, confirm.notes)}
          confirm={t('bookMenu.delete')}
          confirmFirst
          onConfirm={() => void runConfirmed()}
          onCancel={() => setConfirm(undefined)}
        />
      ) : confirm ? (
        <ConfirmDialog
          message={
            confirm.kind === 'empty'
              ? format(t('trash.confirmEmpty'), {
                  notes: noteCount(trash.length, currentLocale()),
                })
              : confirm.kind === 'many'
                ? format(t('trash.confirmMany'), {
                    notes: noteCount(confirm.ids.length, currentLocale()),
                  })
                : format(t('trash.confirmOne'), { title: confirm.title })
          }
          detail={t('trash.cannotUndo')}
          confirm={confirm.kind === 'empty' ? t('trash.empty') : t('trash.deleteForever')}

          onConfirm={() => void runConfirmed()}
          onCancel={() => setConfirm(undefined)}
        />
      ) : null}
    </div>
  )
}
