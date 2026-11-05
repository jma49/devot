// oxlint-disable react/refs, react/purity, react/immutability, react/preserve-manual-memoization -- App predates these React Compiler checks, which skipped it while it held startImport; it is not compiled (#534).
import { isScrolled, scrolledBy } from './scrollEdge'
import { hasDesktopShell } from './platform'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  BatchChange,
  DailyNotesSettings,
  BookRecord,
  ExportReport,
  NoteStatus,
  NoteSummary,
  SavedSearchRecord,
  SaveProblem,
  TagColor,
  TagColorValue,
  TagRecord,
  TakenIn,
  TrashedNote,
} from '../../core'
// Imported directly, not via the core index, to keep the preview pipeline out of the main bundle.
import {
  bookCounts,
  bookIcon,
  bookWithDescendants,
  buildBookTree,
  TEMPLATES_BOOK_ID,
} from '../../core/books'
import { noteLink } from '../../core/links'
import {
  MAX_SAVED_SEARCH_NAME_CHARS,
  countMatches,
  savedQueryText,
  savedSearchQuery,
} from '../../core/savedSearches'
import { clipChars } from '../../core/text'
import { clipTitle } from '../../core/noteLimits'
import { compareNames } from '../../core/sort'
import {
  EMPTY_TRAIL,
  adjacentNote,
  stepTarget,
  trailTo,
  visit,
  type Trail,
} from '../../core/navigation'
import { highlightTerms, parseSearch, searchPattern, type SearchScope } from '../../core/search'
import { filterNotes, noteGroups, statusCounts, tagCounts, type NoteFilter } from '../../core/tags'
import {
  findBookNode,
  workspaceParent,
  workspaceParents,
  workspaceTree,
} from '../../core/workspace'
import { errorCode } from './backups'
import { BackupNotice } from './BackupNotice'
import { SyncNotice } from './SyncNotice'
import { ActivationBar, TrialEndedBar, TrialReminder } from './TrialNotices'
import { runSync, runsSync, startSyncStatus, useSyncSnapshot } from './sync'
import { RestoreSyncChoice } from './RestoreSyncChoice'
import { licenceEntitlements, startLicence, useEditing } from './licence'
import { useLicenceLink } from './LicenceLink'
import { Notices } from './Notices'
import { SearchIndexNotice } from './SearchIndexNotice'
import { REBUILD_SEARCH_INDEX, rebuildSearchIndex, type RebuildState } from './searchIndex'
import { ChangeNotice } from './ChangeNotice'
import { AiSuggestNotice } from './AiSuggestNotice'
import { ImageActionNotice, ImageNotice } from './ImageNotice'
import { MAX_LINK_NOTES } from './linkCompletion'
import { useNarrowWindow } from './narrowWindow'
import {
  fadeInListBody,
  measureModePanes,
  measurePanes,
  type ModeBoxes,
  movePanes,
  type PaneBoxes,
  playModeChange,
  shownPanes,
} from './paneMotion'
import { ExportNotice, failureOf, type ExportFailure } from './ExportNotice'
import { SaveNotice } from './SaveNotice'
import { isImeKey } from './ime'
import { saveEdits, useSaveAtTrialEnd, useSaveOnHide, useSaveProblems } from './saveGuards'
import { BackupsDialog } from './BackupsDialog'
import { useSheets } from './sheets'
import { BookPicker } from './BookPicker'
import { useContextMenu, type MenuPoint } from './contextMenu'
import {
  CHIP_MENU,
  NOTEBOOK_MENU,
  type ChipAction,
  type ChipMenuTarget,
  type NotebookAction,
  type NotebookMenuTarget,
} from './headerMenus'
import { TagSettingsDialog } from './TagSettingsDialog'
import { SavedSearchDialog } from './SavedSearchDialog'
import { SEARCH_FIELD_MENU } from './savedSearchMenu'
import { PageSetupDialog, type PageSetup } from './PageSetupDialog'
import { ImportDialog } from './ImportDialog'
import { IMPORT_FAILED, finishImport, pickImport } from './importer'
import { IMPORT_PICKS, type ImportAction } from './bookMenu'
import { AiAccessDialog } from './AiAccessDialog'
import { AiAccessNotice } from './AiAccessNotice'
import { CHOOSE_AI_ACCESS, inverseChanges, type AiAccessChange } from './aiAccess'
import { BatchNotice } from './BatchNotice'
import { ConfirmDialog } from './ConfirmDialog'
import { CoreNotice } from './CoreNotice'
import { DeepLinkNotice, type DeepLinkProblem } from './DeepLinkNotice'
import { usePlugins } from './plugins/usePlugins'
import { firstImported, openDestination } from './cliOpen'
import { noteTarget, useDeepLinks, type DeepLink } from './deepLink'
import { StartFailure } from './StartFailure'
import { useImageMenu, type ImageMenuTarget, type SetImageSize } from './imageMenu'
import { ImageViewer, type ViewedImage } from './ImageViewer'
import { DB_CHANGED, NOTES_LOADED, useExternalChanges } from './externalChanges'
import { useMarkdownMirror } from './MarkdownMirror'
import { SearchField } from './SearchField'
import { useSearch, useSearchRuns } from './useSearch'
import { areaOf, areaTargets, nextArea, usePaneTab, visible, type Area } from './areas'
import { inEditor, sheetOpen, useMenuEvent, useWindowCommands } from './commands/dispatch'
import { appHandlers } from './commands/appHandlers'
import { useCommandMenu } from './commands/commandMenu'
import { useFormatMenu } from './commands/formatMenu'
import { shortcutLabel } from './commands/keys'
import { commandKeys } from './commands/registry'
import { useKeymap } from './commands/shortcutSettings'
import { invoke } from './ipc'
import { titleWithKey } from './commands/titles'
import { ToolTips } from './ToolTips'
import { withoutChanges } from './commands/registry'
import { CommandPalette } from './palette/CommandPalette'
import { commandEntries, libraryEntries, outlineEntries, sourceEntries } from './palette/entries'
import { paletteActions } from './palette/appActions'
import type { PaletteEntry, PaletteSource } from './palette/results'
import { bookDeleteDetail, noteCount } from './format'
import { openAfter, type ListSelection } from './listSelection'
import { SelectionSummary } from './SelectionSummary'
import { TrashView } from './TrashView'
import { Icon, ToolIcon } from './icons/Icon'
import { BookIcon } from './BookIcon'
import { StatusPicker } from './StatusPicker'
import { tagColorClass, tagColorStyle } from './tagColorStyle'
import { TagEditor } from './TagEditor'
import { BuiltInTemplate, BuiltInTemplates } from './BuiltInTemplates'
import { markWrite } from './lastWrite'
import { TemplatePicker } from './TemplatePicker'
import { currentRecentTemplates } from './templates'
import type { Core } from './core-client'
import { useCoreSession, useCoreStart, useQuitAndClose } from './coreSession'
import { warmUp } from './warmUp'
import { startEarlyKeys } from './editor/earlyKeys'
import {
  currentFocusStore,
  currentSidebarStore,
  currentWindowLabel,
  isSecondaryLabel,
} from './focus'
import { coalesced, listsLink } from './mainWindows'
import { listenHere, unlistenLater } from './windowEvents'
import { useFocusRescue } from './focusRescue'
import { useLastState } from './useLastState'
import {
  currentDefaultMode,
  currentLastStateStore,
  isBoardView,
  isGalleryView,
  layoutOf,
  withLayout,
  type ListLayout,
  type ViewLayouts,
} from './lastState'
import type { FindTarget } from './find/target'
import { useFind } from './find/useFind'
import { headline } from '../../core/extract'
import { refuseTextDrops } from './dragData'
import { displayTitle, displayTitles, newestUntitled, useHeadlines } from './headlines'
import { currentLocale, format, t } from './i18n'
import { useAlertMenu } from './editor/alertMenu'
import type { EditorHandle } from './editor/handle'
import { NoteEditor, type ApplyRestore } from './NoteEditor'
import { BODY_PLACEHOLDER_MS, useLateAttribute } from './late'
import { changeEditorSettings, editorSettings, useEditorSetting } from './editorSettings'
import { ModeControl, editorOnly, type Mode } from './ModeControl'
import { relayGate, relayLink } from './noteRelay'
import { NoteList } from './NoteList'
import { NoteBoard } from './NoteBoard'
import { NoteGallery } from './NoteGallery'
import { cardLabels } from './galleryPreviews'
import { LayoutControl } from './LayoutControl'
import {
  appliedChanges,
  boardColumns,
  boardOrder,
  boardStatuses,
  changesByStatus,
  createBoardHistories,
  moveChanges,
  redoChanges,
  stepChanges,
  undoChanges,
  type BoardMove,
} from './board'
import {
  homeOf,
  keepUnchanged,
  retitled,
  sameCounts,
  sameSearchRows,
  viewLists,
  withWrites,
  type ListView,
} from './listUpdates'
import { useNoteActions } from './noteActions'
import { useTrashMenu } from './trashMenu'
import { type ExportAction, type NoteAction, type TrashAction, copyText } from './noteMenu'
import { applyOrder, orderChip, orderLabel, sortLocales, sortView, useListOrder } from './noteSort'
import { LivePreview } from './preview/Preview'
import { tagChanges, type FrontMatterChange } from './preview/frontMatterApply'
import { syncScrolling, type ScrollPane } from './preview/scrollSync'
import { RevisionHistory, useHistoryMenu } from './RevisionHistory'
import { useHistoryBar } from './HistoryBar'
import { LiveCountsFooter, countsStore } from './CountsFooter'
import { OutlinePanel, lineStore } from './outline/OutlinePanel'
import { scrollPreviewTo } from './outline/room'
import { useOutlineRoom } from './outline/useOutlineRoom'
import { inNotes, markSeen, unseenOf, useAgentWrites } from './agentWrites'
import { AuthorshipNotice } from './AuthorshipNotice'
import { writerLabel, type WriterRef } from './authorshipLabels'
import { AiEditSheet } from './AiEditSheet'
import { aiTransport } from './ai'
import type { AiEditStart } from './editor/aiMenu'
import { createAiGenerator } from '../../core/aiProvider'
import { createSuggester } from '../../core/aiSuggest'
import { loadAiSettings } from './settings/aiProviders'
import { Activity, useActivityMenu } from './Activity'
import {
  choicesFromTree,
  notebookForNewNote,
  publishNotebooks,
  publishTemplates,
} from './notebookChoices'
import {
  agentFilter,
  Sidebar,
  STATUSES,
  type Selection,
  type SidebarMenus,
  type SidebarWorkspace,
} from './Sidebar'
import { useKept, useStable } from './stable'
import { textStore } from './textStore'
import { useUpdates } from './UpdateNotice'
import { track } from './usage'
import { useCliAppend, useHttpApi, useQuickCapture } from './hostCalls'

const EXPORT_ALL = 'devot:export-all'

export const SHOW_PALETTE = 'devot:show-palette'
export const OPEN_TODAY = 'devot:open-today'

const dailySettings = (): DailyNotesSettings => {
  const { dailyNotebook, dailyTemplate, dailyTitleFormat } = editorSettings()
  return { dailyNotebook, dailyTemplate, dailyTitleFormat }
}

export const TOGGLE_PREVIEW = 'devot:toggle-preview'
export const SHOW_SPLIT = 'devot:show-split'

/** How many untitled notes the palette looks up the first line of (the newest). */
const PALETTE_HEADLINES = 500
const NO_LIBRARY = { book: [], tag: [], note: [] }

// Stable identity so the memoized list and sidebar skip equal props.
const NO_NOTES: NoteSummary[] = []
const LAYOUTS_WITH_BOARD: readonly ListLayout[] = ['list', 'board', 'gallery']
const LAYOUTS_WITHOUT_BOARD: readonly ListLayout[] = ['list', 'gallery']
const NO_TAGS: ReadonlyMap<string, TagRecord> = new Map()
const NO_FOLDS: ReadonlySet<string> = new Set()
const ALL_NOTES: Selection = { kind: 'all' }

/** Each title change re-sorts the lists, so typing is debounced by this much. */
const LIST_TITLE_MS = 150

const EDITOR_REMEASURE_MS = 100

export const TOGGLE_SIDEBAR = 'devot:toggle-sidebar'

/** A menu toggle this soon after the key did the same is that key press echoing through the menu; it is dropped. */
const MENU_ECHO_MS = 500

// Other main windows hear of this window's writes this long after the first of a burst, and load their lists this long after hearing (mainWindows.ts).
const LISTS_WROTE_MS = 250
const LISTS_RELOAD_MS = 400

function SidebarToggle({ shown, onClick }: { shown: boolean; onClick: () => void }) {
  // Re-render on keymap changes: the tooltip names the key in effect.
  useKeymap()
  return (
    <>
      <span className="window-inset" aria-hidden="true" data-tauri-drag-region />
      {/* Never part of the window's drag region, which the header around it is. */}
      <button
        type="button"
        className="tool sidebar-toggle"
        data-tauri-drag-region="false"
        aria-label={t(shown ? 'command.hideSidebar' : 'command.showSidebar')}
        title={titleWithKey(shown ? 'sidebar.hideTitle' : 'sidebar.showTitle', 'view.sidebar')}
        onClick={onClick}
      >
        <ToolIcon name="sidebar.toggle" />
      </button>
    </>
  )
}

const AREA_ASK_MS = 1000
const WORKSPACE_FOCUS_MS = 100
const WORKSPACE_LEAVE_FOCUS_MS = 10

type FocusRequest =
  | { kind: 'area'; area: Area }
  /** `start`: the caret at the start of the body. */
  | { kind: 'title' | 'body'; id: string; start?: boolean }

interface FocusReturn {
  editor: boolean
  element: HTMLElement | null
}

export function App() {
  // The last state restores view, filter and mode at once, the open note once the lists load (lastState.ts).
  const lastStateStore = useMemo(() => currentLastStateStore(), [])
  const [lastState] = useState(() => lastStateStore.load())
  // Tooltips name the keys in effect; they follow the user's changes.
  useKeymap()
  const session = useCoreSession()
  const { core, coreRef, startFailure, coreFailure, setCoreFailure, retryStart } = session
  // Every AI request goes through the access rule, with the notebooks as the core has them.
  const aiGenerator = useMemo(
    () =>
      core &&
      createAiGenerator({
        storage: { listBooks: () => core.listBooks() },
        transport: aiTransport,
        entitlements: licenceEntitlements,
      }),
    [core],
  )
  // Next edit suggestions go through the same rule, and the AI settings are read afresh at each request.
  const suggester = useMemo(
    () =>
      core &&
      aiGenerator &&
      createSuggester({
        generator: aiGenerator,
        bookOf: async (id) => (await core.read(id)).bookId,
        listBooks: () => core.listBooks(),
        settings: loadAiSettings,
        entitlements: licenceEntitlements,
      }),
    [core, aiGenerator],
  )
  const [suggestNotice, setSuggestNotice] = useState<string>()
  const loadHeadlines = useMemo(
    () => (core ? (ids: string[]) => core.headlines(ids) : undefined),
    [core],
  )
  const loadDetails = useMemo(
    () => (core ? (ids: string[]) => core.rowDetails(ids) : undefined),
    [core],
  )
  const loadCardPreviews = useMemo(
    () => (core ? (ids: string[]) => core.cardPreviews(ids, cardLabels()) : undefined),
    [core],
  )
  const activityStrip = useEditorSetting('activityStrip')
  const loadStrips = useMemo(
    () =>
      core && activityStrip ? (ids: string[]) => core.noteActivity(ids, Date.now()) : undefined,
    [core, activityStrip],
  )
  const [listsLoaded, setListsLoaded] = useState(false)
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [books, setBooks] = useState<BookRecord[]>([])
  const [library, setLibrary] = useState<Selection>(() => lastState?.view ?? { kind: 'all' })
  // Notebook open as a workspace (the sidebar shows only it); a view or note outside it, or the notebook going, leaves it.
  const [workspace, setWorkspace] = useState<string | null>(() =>
    lastState?.view.kind === 'book' ? (lastState.workspace ?? null) : null,
  )
  const [tags, setTags] = useState<TagRecord[]>([])
  const [savedSearches, setSavedSearches] = useState<SavedSearchRecord[]>([])
  // Save Search (no `id`) or Edit Saved Search.
  const [searchDialog, setSearchDialog] = useState<{ id?: string; name: string; query: string }>()
  const [ranSearch, setRanSearch] = useState<string>()
  const [filter, setFilter] = useState<NoteFilter | null>(() =>
    lastState?.view.kind === 'templates' ? null : (lastState?.filter ?? null),
  )
  const [trash, setTrash] = useState<TrashedNote[]>([])
  const [templates, setTemplates] = useState<NoteSummary[]>([])
  const [builtIn, setBuiltIn] = useState<string>()
  // Template picker: recent ones are read on open; with `into`, the pick fills that empty note instead of making a new one.
  const [picking, setPicking] = useState<{ recent: string[]; into?: string }>()
  const recentTemplates = useMemo(() => currentRecentTemplates(), [])
  const searchState = useSearch(core)
  const { query, setQuery, searchIn, setSearchIn, results, setResults, searchField } = searchState
  const { rerunSearch, askSearchField } = searchState
  const searching = query.trim() !== '' && results !== undefined
  const [confirm, setConfirm] = useState<
    | { kind: 'empty' }
    | { kind: 'one'; id: string; title: string }
    | { kind: 'many'; ids: readonly string[] }
    | { kind: 'tag'; id: string; name: string; count: number }
    | { kind: 'savedSearch'; id: string; name: string }
    | { kind: 'book'; id: string; name: string; subs: number; notes: number }
  >()
  const [renamingBook, setRenamingBook] = useState<string>()
  const [selected, setSelected] = useState<string>()
  // Several notes selected (listSelection.ts); the open note stays open among them. Bound to the view it was made in (`listView`).
  const [multi, setMultiIn] = useState<{
    view: string
    selection: ListSelection
  }>()
  const [batchFailed, setBatchFailed] = useState<number>()
  const [aiAccessPicker, setAiAccessPicker] = useState(false)
  const [aiAccessResult, setAiAccessResult] = useState<{
    changes: readonly AiAccessChange[]
    failed: number
  }>()
  useEffect(() => refuseTextDrops(window), [])
  const [title, setTitle] = useState('')
  // Note whose editor takes the keyboard on open: one just created, or opened by a palette action from the editor (opening from the list leaves it there).
  const [takesKeyboard, setTakesKeyboard] = useState<string>()
  const [mode, setMode] = useState<Mode>(() => lastState?.mode ?? currentDefaultMode())
  // Leaving Preview or Split goes back to the editor mode used last.
  const editorMode = useRef(editorOnly(mode) ? mode : currentDefaultMode())
  if (editorOnly(mode)) editorMode.current = mode
  // The library views shown as a board (lastState.ts).
  const [layouts, setLayouts] = useState<ViewLayouts>(() => ({
    boards: lastState?.boards ?? [],
    galleries: lastState?.galleries ?? [],
  }))
  const focusStore = useMemo(() => currentFocusStore(), [])
  const [focus, setFocus] = useState(() => focusStore.load())
  const toggleFocus = useCallback(() => {
    setFocus((on) => {
      focusStore.save(!on)
      return !on
    })
  }, [focusStore])
  const sidebarStore = useMemo(() => currentSidebarStore(), [])
  const [sidebarHidden, setSidebarHidden] = useState(() => sidebarStore.load())
  // A narrow window hides the sidebar until Show Sidebar asks; the request lasts until the window crosses the threshold again. Neither is stored.
  const narrow = useNarrowWindow()
  const [askedIn, setAskedIn] = useState<boolean | null>(null)
  if (!narrow && askedIn !== null) setAskedIn(null)
  const sidebarOff = sidebarHidden || (narrow && askedIn !== narrow)
  const sidebarShown = !focus && !sidebarOff
  // Hide/show fades and slides the panes (paneMotion.ts): positions are measured before the change renders and played back after layout.
  // Panes are inert from the first frame of a hide, so the keyboard leaves them as it did when they vanished at once.
  const [panesSeen, setPanesSeen] = useState({ focus, sidebarOff })
  const panesBefore = useRef<PaneBoxes | null>(null)
  if (panesSeen.focus !== focus || panesSeen.sidebarOff !== sidebarOff) {
    panesBefore.current = measurePanes(shownPanes(panesSeen))
    setPanesSeen({ focus, sidebarOff })
  }
  useLayoutEffect(() => {
    const before = panesBefore.current
    panesBefore.current = null
    if (!before) return
    movePanes(before, shownPanes(panesSeen))
    const timer = setTimeout(() => editorRef.current?.remeasure(), EDITOR_REMEASURE_MS)
    return () => clearTimeout(timer)
  }, [panesSeen])
  useLayoutEffect(() => {
    document.querySelector('.window > .sidebar')?.toggleAttribute('inert', focus || sidebarOff)
    document.querySelector('.window > .list')?.toggleAttribute('inert', focus)
    // A start that failed is replaced by a fresh window (Try Again): its panes are new.
  }, [focus, sidebarOff, startFailure])
  // Notes opened, for Back and Forward. The ref moves at once so quick presses each step on; the state renders it.
  const trailRef = useRef<Trail>(EMPTY_TRAIL)
  const [trail, setTrail] = useState(EMPTY_TRAIL)
  const moveTrail = (next: Trail) => {
    trailRef.current = next
    setTrail(next)
  }
  // Note a navigation is opening until the window shows it: quick Back/Forward/Next/Previous presses step on from it. Each open bumps `opens`; only the latest shows.
  const openingRef = useRef<string | undefined>(undefined)
  const opens = useRef(0)
  // The title field shows the note being left until the switch lands; typing then would rename that
  // note or merge with the title that arrives, so it is read-only meanwhile.
  // The list draws the note being opened as selected at once.
  const [openingId, setOpeningId] = useState<string>()
  const switching = openingId !== undefined && openingId !== selected
  // A title another window gave the note being opened, before its own title arrived.
  const openingTitle = useRef<{ noteId: string; title: string } | undefined>(undefined)
  const startOpening = (id: string) => {
    openingRef.current = id
    openingTitle.current = undefined
    setOpeningId(id)
    return ++opens.current
  }
  const stopOpening = () => {
    openingRef.current = undefined
    setOpeningId(undefined)
  }
  // A body opened for the editor to show next, held until the editor takes it.
  const preopened = useRef<{ core: Core; noteId: string; state: Uint8Array } | null>(null)
  const handOver = (next: { core: Core; noteId: string; state: Uint8Array }) => {
    const before = preopened.current
    if (before) void before.core.unhold(before.noteId)
    preopened.current = next
  }
  const takePreopened = useStable((from: Core, noteId: string) => {
    const given = preopened.current
    if (given?.core !== from || given.noteId !== noteId) return undefined
    preopened.current = null
    return given.state
  })
  // The editor takes a body in the commit that selects its note, in a layout effect that runs before
  // this one: a body still here was not taken (no editor shown, a multiple selection) and would go stale.
  useLayoutEffect(() => {
    const left = preopened.current
    if (!left) return
    preopened.current = null
    void left.core.unhold(left.noteId)
  })
  const [editorLoading, setEditorLoading] = useState(false)
  const panesRef = useRef<HTMLDivElement>(null)
  useLateAttribute(panesRef, 'data-loading', switching || editorLoading, BODY_PLACEHOLDER_MS)
  useEffect(() => {
    if (openingRef.current === selected) stopOpening()
  })
  const focusAfter = useRef<FocusRequest>(undefined)
  const focusAskedAt = useRef(0)
  const [, setFocusAsked] = useState(0)
  const requestFocus = (request: FocusRequest) => {
    focusAfter.current = request
    focusAskedAt.current = performance.now()
    setFocusAsked((n) => n + 1)
  }
  const titleRef = useRef<HTMLInputElement>(null)
  const tagInputRef = useRef<HTMLInputElement>(null)
  const [quickTagNote, setQuickTagNote] = useState<string>()
  const syncSnapshot = useSyncSnapshot()
  useEffect(() => startSyncStatus(), [])
  // Re-renders when the licence changes, so what is locked follows it.
  const editing = useEditing()
  useEffect(() => startLicence(), [])
  const licenceLink = useLicenceLink()
  const [indexState, setIndexState] = useState<RebuildState>()
  const indexRunning = useRef(false)
  const [changeNotice, setChangeNotice] = useState<string>()
  const [imageNotice, setImageNotice] = useState<string[]>()
  const [linkNotice, setLinkNotice] = useState<DeepLinkProblem>()
  const updates = useUpdates()
  const [exportNotice, setExportNotice] = useState<{
    failure: ExportFailure
    code: string
    values?: Record<string, string | number>
  }>()
  // Print and Export as PDF ask for the page setup first.
  const [pageSetupFor, setPageSetupFor] = useState<{
    action: 'print' | 'exportPdf'
    id: string
  }>()
  // The first quit or close after a save failure is held (saving.ts, useSaveProblems).
  const [quitHeld, setQuitHeld] = useState(false)
  const [closeHeld, setCloseHeld] = useState(false)
  // The open note's Markdown mirrored for the preview; not App state, so typing renders only the preview.
  const [openText] = useState(() => textStore())
  const [historyFor, setHistoryFor] = useState<string>()
  const [aiEditing, setAiEditing] = useState<{ noteId: string; start: AiEditStart }>()
  const [activityOpen, setActivityOpen] = useState(false)
  useActivityMenu(() => setActivityOpen(true))
  const restoreRef = useRef<ApplyRestore | null>(null)
  const [editorFind, setEditorFind] = useState<FindTarget | null>(null)
  const [previewFind, setPreviewFind] = useState<FindTarget | null>(null)
  const editorRef = useRef<EditorHandle | null>(null)
  // `main` hosts what runs once (the mirror, compaction); a window File > New Window opened does not (mainWindows.ts).
  const [label] = useState(currentWindowLabel)
  const primary = !isSecondaryLabel(label)
  // The engine needs Rust's storage and socket, which the UI tests' build does not have.
  useEffect(
    () => (core && runsSync(label) && !DEVOT_UI_TEST ? runSync(core) : undefined),
    [core, label],
  )
  // What this window's core says to the other windows, and hears from them (noteRelay.ts).
  const [relay] = useState(() => ({ link: relayLink(label), gate: relayGate(false) }))
  const [lists] = useState(() => {
    const link = listsLink(label)
    return { link, wrote: coalesced(() => link.send(), LISTS_WROTE_MS) }
  })
  const shownNote = useRef<string | undefined>(undefined)
  shownNote.current = selected
  const sidebarMenus = useRef<SidebarMenus | null>(null)
  // Split mode keeps editor and preview at the same line unless synced scrolling is off (an editor setting).
  const syncScroll = useEditorSetting('syncScroll')
  const listDates = useEditorSetting('listDates')
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
  }, [editorPane, previewPane, mode, selected])
  // Coming from Preview, the place being read leads; otherwise the editor does.
  const modeBefore = useRef(mode)
  useEffect(() => {
    const lead = modeBefore.current === 'preview' ? 'second' : 'first'
    modeBefore.current = mode
    if (mode !== 'split' || !syncScroll || !editorPane || !previewPane) return
    return syncScrolling(editorPane, previewPane, { lead })
  }, [mode, syncScroll, editorPane, previewPane])
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
  const [viewing, setViewing] = useState<ViewedImage | null>(null)
  const paletteReturn = useRef<FocusReturn>(undefined)
  // While a palette action picked from the editor runs, a note it opens
  // takes the keyboard into its editor.
  const paletteFromEditor = useRef(false)
  // Counts palette actions that have finished; see `closePalette`.
  const [paletteDone, setPaletteDone] = useState(0)

  // Moves when this device's agent_writes rows may have changed: a reload of the lists, or a write that changed a note's rows.
  const [authorship, setAuthorship] = useState(0)
  const authorshipChanged = useCallback(() => setAuthorship((n) => n + 1), [])

  const refresh = useCallback(
    async (c: Core) => {
      const [listed, nextBooks, nextTags, nextTrash, nextSearches] = await Promise.all([
        c.listWithTemplates(),
        c.listBooks(),
        c.listTags(),
        c.listTrash(),
        c.listSavedSearches(),
      ])
      const nextNotes = listed.notes
      setTrash(nextTrash)
      // Notes that did not change keep their objects (and their rows their render).
      setTemplates((prev) => keepUnchanged(prev, listed.templates))
      setNotes((prev) => keepUnchanged(prev, nextNotes))
      authorshipChanged()
      setBooks(nextBooks)
      setTags(nextTags.sort((a, b) => compareNames(a.name, b.name, navigator.languages)))
      setSavedSearches(nextSearches)
      // Results follow edits, renames, trash and restore.
      rerunSearch()
      window.dispatchEvent(new CustomEvent(NOTES_LOADED))
      return { notes: nextNotes, templates: listed.templates, books: nextBooks }
    },
    [authorshipChanged, rerunSearch],
  )

  // Every note write dates the note in the lists at once, so an edited note moves without a reload.
  // Not for a change that reloads the lists when done (`changeBooks`): a re-dated note could move before the reload removes it, sending the keyboard to the wrong row.
  const reloadsPending = useRef(0)
  const showWrites = useCallback(
    (writes: ReadonlyMap<string, number>) => {
      for (const at of writes.values()) markWrite(at)
      if (reloadsPending.current > 0) return
      setNotes((list) => withWrites(list, writes))
      setTemplates((list) => withWrites(list, writes))
      setResults((shown) => {
        const found = shown && withWrites(shown.found, writes)
        return shown && found !== shown.found ? { ...shown, found: found! } : shown
      })
    },
    [setResults],
  )

  // Notes the core could not save yet: once a note saves, the lists show what is stored.
  const {
    problems: saveProblems,
    noticeShown: saveNoticeShown,
    setDismissed: setSaveNoticeDismissed,
    quitGuard,
    closeGuard,
    onSaveProblems,
  } = useSaveProblems(
    useCallback(
      (previous: readonly SaveProblem[], next: SaveProblem[]) => {
        if (next.length === 0) {
          setQuitHeld(false)
          setCloseHeld(false)
        }
        const c = coreRef.current
        if (c && previous.some((p) => !next.some((n) => n.id === p.id))) {
          void refresh(c).catch(() => {})
        }
      },
      [coreRef, refresh],
    ),
  )

  // Callbacks that outlive a render (finished import, New Notebook) change view through the latest rules (`showLibrary`).
  const showLibraryRef =
    useRef<(next: Selection, options?: { clearFilter?: boolean }) => void>(undefined)

  const {
    importJob,
    importKey,
    backupsOpen,
    backupNotice,
    setBackupNotice,
    nextSheet,
    startImport,
    closeImport,
    showBackups,
    closeBackups,
    restore,
  } = useSheets({ core, coreRef, refresh, showLibraryRef })

  const tree = useMemo(() => buildBookTree(books), [books])
  useEffect(() => publishNotebooks(choicesFromTree(tree)), [tree])
  useEffect(
    () => publishTemplates(templates.map((n) => ({ id: n.id, title: n.title }))),
    [templates],
  )
  const counts = useKept(
    useMemo(() => bookCounts(notes, books), [notes, books]),
    sameCounts,
  )
  const libraryBook = library.kind === 'book' ? books.find((b) => b.id === library.id) : undefined
  const workspaceFound = useMemo(
    () => (workspace === null ? undefined : findBookNode(tree, workspace)),
    [tree, workspace],
  )
  const workspaceIds = useMemo(
    () => (workspaceFound ? bookWithDescendants(books, workspaceFound.id) : undefined),
    [books, workspaceFound],
  )
  const workspaceNode =
    workspaceFound && library.kind === 'book' && workspaceIds?.has(library.id)
      ? workspaceFound
      : undefined
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
          bodyVersion: 0,
          bookId: n.bookId,
          status: 'none',
          pinned: false,
          tagIds: [],
        })),
      )),
    [trash],
  )
  const agentWrites = useAgentWrites(core, authorship)
  // In a workspace the Agents section counts only its notes, and choosing an agent lists only those.
  const workspaceNoteIds = useMemo(
    () =>
      workspaceNode && workspaceIds
        ? new Set(
            notes.filter((n) => n.bookId !== null && workspaceIds.has(n.bookId)).map((n) => n.id),
          )
        : undefined,
    [notes, workspaceNode, workspaceIds],
  )
  const agents = useMemo(
    () =>
      workspaceNoteIds
        ? inNotes(agentWrites.view, workspaceNoteIds).agents
        : agentWrites.view.agents,
    [agentWrites.view, workspaceNoteIds],
  )
  // An agent's filter takes the notes it changed from this device's rows as they are now.
  const activeFilter = useMemo(() => {
    if (inTemplates) return null
    if (filter?.kind === 'tag' && !tags.some((tag) => tag.id === filter.tagId)) return null
    if (filter?.kind !== 'agent') return filter
    const agent = agents.find((a) => a.key === filter.writer)
    return agent ? agentFilter(agent) : null
  }, [inTemplates, filter, tags, agents])
  // An agent filter whose agent is gone (its notes were trashed, or a workspace holds none of
  // them) is cleared, not only hidden: it must not turn back on by itself when the agent writes
  // again. Adjusted while rendering (React's rule for state that a change of inputs made stale),
  // so the list and the sidebar both see no filter at once.
  if (filter?.kind === 'agent' && !agents.some((agent) => agent.key === filter.writer)) {
    setFilter(null)
  }
  const listOrder = useListOrder(
    sortView({
      search: searching,
      bookId: inTemplates ? TEMPLATES_BOOK_ID : (libraryBook?.id ?? null),
      filter: activeFilter,
    }),
  )
  const order = listOrder.order
  const libraryView = `${sortView({ search: false, bookId: null, filter: activeFilter })}|${libraryBook?.id ?? ''}`
  const listView = searching
    ? `search|${JSON.stringify(results.search)}`
    : inTrash
      ? 'trash'
      : inTemplates
        ? 'templates'
        : libraryView
  const canBoard = !searching && !inTrash && !inTemplates && isBoardView(listView)
  const libraryLayout = layoutOf(layouts, libraryView)
  const boardShown = canBoard && libraryLayout === 'board'
  // A search within a view shown as a gallery shows its results as one.
  const canGallery =
    !inTrash &&
    !inTemplates &&
    isGalleryView(libraryView) &&
    (!searching || (searchIn === 'view' && libraryLayout !== 'board'))
  const galleryShown = canGallery && libraryLayout === 'gallery'
  const shownLayout: ListLayout = boardShown ? 'board' : galleryShown ? 'gallery' : 'list'
  const boardDropped = useEditorSetting('boardDropped')
  const boardStatusList = useMemo(() => boardStatuses(boardDropped), [boardDropped])
  const showAlertMenu = useAlertMenu()
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
  // A card moved shows in its new column at once, until the lists have the change.
  const [movedTo, setMovedTo] = useState<ReadonlyMap<string, NoteStatus>>(() => new Map())
  const boardNotes = useMemo(() => {
    const listed =
      activeFilter?.kind === 'pinned' ? groups.pinned : [...groups.pinned, ...groups.others]
    if (movedTo.size === 0) return listed
    return listed.map((n) => {
      const status = movedTo.get(n.id)
      return status === undefined || status === n.status ? n : { ...n, status }
    })
  }, [groups, activeFilter, movedTo])
  const templateRows = useMemo(
    () => noteGroups(applyOrder(templates, order, locales)),
    [templates, order, locales],
  )
  const shownResults = useMemo(() => {
    const found = results?.found ?? []
    // Search looks at notes, not at this device's agent rows: an agent's view keeps to its notes here.
    const agentNotes =
      results?.search.scope && activeFilter?.kind === 'agent' ? activeFilter.noteIds : undefined
    return applyOrder(
      agentNotes ? found.filter((n) => agentNotes.has(n.id)) : found,
      order,
      locales,
    )
  }, [results, order, locales, activeFilter])
  const galleryNotes = useMemo(
    () =>
      searching
        ? shownResults
        : activeFilter?.kind === 'pinned'
          ? groups.pinned
          : [...groups.pinned, ...groups.others],
    [searching, shownResults, activeFilter, groups],
  )
  const tagsById = useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags])
  const sidebarNotes = useMemo(
    () =>
      workspaceNode && workspaceIds
        ? notes.filter((n) => n.bookId !== null && workspaceIds.has(n.bookId))
        : notes,
    [notes, workspaceNode, workspaceIds],
  )
  const statuses = useKept(
    useMemo(() => statusCounts(sidebarNotes), [sidebarNotes]),
    sameCounts,
  )
  const sidebarTagged = useKept(
    useMemo(() => tagCounts(sidebarNotes), [sidebarNotes]),
    sameCounts,
  )
  // Counted from the listed notes' fields, so a status or tag change shows at once; one with text has no count (only a search finds text).
  const savedSearchQueries = useMemo(() => {
    const scope = workspaceNode ? { bookId: workspaceNode.id, filter: null } : undefined
    return savedSearches.map((search) => ({
      search,
      resolved: savedSearchQuery(search, { books, tags, scope }),
    }))
  }, [savedSearches, books, tags, workspaceNode])
  const savedSearchRows = useKept(
    useMemo(
      () =>
        savedSearchQueries.map(({ search, resolved }) => ({
          id: search.id,
          name: search.name,
          count: countMatches(sidebarNotes, resolved),
        })),
      [savedSearchQueries, sidebarNotes],
    ),
    sameSearchRows,
  )
  const sidebarTags = useMemo(
    () => (workspaceNode ? tags.filter((tag) => (sidebarTagged.get(tag.id) ?? 0) > 0) : tags),
    [workspaceNode, tags, sidebarTagged],
  )
  const sidebarTree = useMemo(
    () => (workspaceNode ? workspaceTree(tree, workspaceNode.id) : tree),
    [tree, workspaceNode],
  )
  const sidebarWorkspace = useMemo<SidebarWorkspace | undefined>(
    () =>
      workspaceNode
        ? {
            book: workspaceNode,
            parents: workspaceParents(tree, workspaceNode.id),
            library: tree,
          }
        : undefined,
    [tree, workspaceNode],
  )
  const pinnedCount = useMemo(() => notes.filter((n) => n.pinned).length, [notes])
  const filterLabel =
    activeFilter === null
      ? undefined
      : activeFilter.kind === 'pinned'
        ? t('sidebar.pinned')
        : activeFilter.kind === 'status'
          ? t(`status.${activeFilter.status}`)
          : activeFilter.kind === 'agent'
            ? (() => {
                const agent = agents.find((a) => a.key === activeFilter.writer)
                return agent ? writerLabel(agent) : undefined
              })()
            : tags.find((tag) => tag.id === activeFilter.tagId)?.name
  const selectedNote =
    notes.find((n) => n.id === selected) ?? templates.find((n) => n.id === selected)
  const selectedIsTemplate = selectedNote?.bookId === TEMPLATES_BOOK_ID
  const viewName =
    filterLabel !== undefined && libraryBook
      ? format(t('search.filterInBook'), {
          filter: filterLabel,
          book: libraryBook.name,
        })
      : (filterLabel ?? libraryBook?.name ?? t('sidebar.allNotes'))
  const inView = searchIn === 'view' && !inTrash && !inTemplates
  // A search over every note shows nothing selected in the sidebar; the view returns when the search clears, and a row pressed meanwhile shows its own view.
  const searchingAll = searching && !inView
  /**
   * Every view change (sidebar, palette, New Notebook, finished import) goes through here, so the same rules apply:
   * - the search is cleared, and a search over every note, which hid the
   *   view, also drops the filter that did not show as pressed;
   * - switching between the Trash and the rest closes the open note;
   * - filters narrow the library, not Templates.
   * `clearFilter` also turns the filter off (the arrow keys in the sidebar,
   * a finished import).
   */
  const showLibrary = (next: Selection, options?: { clearFilter?: boolean }) => {
    const clearFilter = searchingAll || options?.clearFilter || next.kind === 'templates'
    // A view outside the workspace leaves it; so does a workspace no longer shown (its notebook went or moved out), on the next view change.
    if (
      workspace !== null &&
      (!workspaceNode || !(next.kind === 'book' && workspaceIds?.has(next.id)))
    ) {
      setWorkspace(null)
    }
    clearSearch()
    if ((next.kind === 'trash') !== inTrash) setSelected(undefined)
    if (clearFilter) setFilter(null)
    setLibrary(next)
  }
  const showFilter = (next: NoteFilter | null) => {
    // A search over every note hid its notebook: the filter pressed covers
    // every note (in a workspace, every note of the workspace).
    const everyNote = searchingAll || inTrash || inTemplates
    clearSearch()
    if (everyNote)
      showLibrary(workspaceNode ? { kind: 'book', id: workspaceNode.id } : { kind: 'all' })
    setFilter(next)
  }
  const firstNoteWanted = useRef(false)
  const openWorkspace = (id: string) => {
    if (!books.some((b) => b.id === id)) return
    showLibraryRef.current?.({ kind: 'book', id }, { clearFilter: true })
    setWorkspace(id)
    firstNoteWanted.current = true
    setTimeout(() => requestFocus({ kind: 'area', area: 'sidebar' }), WORKSPACE_FOCUS_MS)
  }
  const leaveWorkspace = () => {
    setWorkspace(null)
    setTimeout(() => requestFocus({ kind: 'area', area: 'sidebar' }), WORKSPACE_LEAVE_FOCUS_MS)
  }
  const workspaceUp = () => {
    if (!workspaceNode) return
    const parent = workspaceParent(tree, workspaceNode.id)
    if (parent === null) leaveWorkspace()
    else openWorkspace(parent)
  }
  useEffect(() => {
    showLibraryRef.current = showLibrary
  })
  const viewBookId = libraryBook?.id ?? null
  const searchScope = useMemo<SearchScope | undefined>(
    () =>
      inView
        ? { bookId: viewBookId, filter: activeFilter?.kind === 'agent' ? null : activeFilter }
        : undefined,
    [inView, viewBookId, activeFilter],
  )
  const resultsQuery = results?.search.query ?? ''
  const highlight = useMemo(() => {
    const terms = highlightTerms(parseSearch(resultsQuery), tags)
    return {
      title: searchPattern(terms.title),
      body: searchPattern(terms.body),
    }
  }, [resultsQuery, tags])

  const listedIds = useMemo(
    () =>
      (searching
        ? shownResults
        : inTrash
          ? trash
          : inTemplates
            ? [...templateRows.pinned, ...templateRows.others]
            : boardShown
              ? boardOrder(boardColumns(boardNotes, boardStatusList)).map((id) => ({ id }))
              : activeFilter?.kind === 'pinned'
                ? groups.pinned
                : [...groups.pinned, ...groups.others]
      ).map((n) => n.id),
    [
      searching,
      shownResults,
      inTrash,
      trash,
      inTemplates,
      templateRows,
      activeFilter,
      groups,
      boardShown,
      boardNotes,
      boardStatusList,
    ],
  )
  // Multi selection is kept to the listed notes: fewer than two is none.
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
  const knownNotes = useRef(noteById)
  knownNotes.current = noteById
  const selectedNotes = useMemo(
    () => multiIds?.flatMap((id) => noteById.get(id) ?? []) ?? [],
    [multiIds, noteById],
  )

  // Another window's change, or one the core merged in on saving: the editor and title field take it.
  const takeIn = useCallback((change: TakenIn) => {
    if (change.kind === 'title') {
      if (shownNote.current === change.noteId) setTitle(change.title)
      else if (openingRef.current === change.noteId) openingTitle.current = change
      return
    }
    const editor = editorRef.current
    if (editor?.noteId === change.noteId) editor.takeState(change.update)
  }, [])
  useCoreStart(session, {
    primary,
    lists,
    relay,
    refresh,
    nextSheet,
    onSaveProblems,
    showWrites,
    authorshipChanged,
    takeIn,
    setListsLoaded,
  })

  useSearchRuns(searchState, { scope: searchScope, inView })
  // Typing a search in the Trash or Templates leaves it: neither is searched.
  const changeQuery = (next: string) => {
    if ((inTrash || inTemplates) && next.trim()) {
      if (inTrash) setSelected(undefined)
      setLibrary({ kind: 'all' })
      setWorkspace(null)
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
  // Search shortcuts focus the field from anywhere (Shift+Cmd+F: current view, Shift+Opt+Cmd+F: every note); results need the list, so they leave focus mode first.
  const startSearch = useCallback(
    (where: 'all' | 'view') => {
      focusStore.save(false)
      setFocus(false)
      setSearchIn(where)
      askSearchField()
    },
    [focusStore, setSearchIn, askSearchField],
  )

  // Help > Rebuild Search Index and the palette command. The notes stay usable
  // meanwhile; their reads and saves wait for the one statement. Rust refuses
  // a second rebuild while one runs, but the window does not ask.
  const rebuildIndex = useCallback(async () => {
    if (!core || indexRunning.current) return
    indexRunning.current = true
    try {
      await rebuildSearchIndex(setIndexState, () => refresh(core))
    } finally {
      indexRunning.current = false
    }
  }, [core, refresh])
  const rebuildIndexRef = useRef(rebuildIndex)
  useEffect(() => {
    rebuildIndexRef.current = rebuildIndex
  }, [rebuildIndex])
  useEffect(() => {
    const run = () => void rebuildIndexRef.current()
    window.addEventListener(REBUILD_SEARCH_INDEX, run)
    const unlisten = DEVOT_UI_TEST
      ? undefined
      : unlistenLater(
          listenHere('devot://rebuild-search-index', () =>
            window.dispatchEvent(new CustomEvent(REBUILD_SEARCH_INDEX)),
          ),
        )
    return () => {
      window.removeEventListener(REBUILD_SEARCH_INDEX, run)
      unlisten?.()
    }
  }, [])
  useEffect(() => {
    if (indexState?.phase !== 'done') return
    const timer = setTimeout(() => setIndexState(undefined), 5000)
    return () => clearTimeout(timer)
  }, [indexState])

  // Another process changed the database: notes in memory take in its writes before saving anything (so no save overwrites them), then pending edits save and the lists reload.
  useExternalChanges(
    core
      ? async () => {
          const shown = selected && !inTrash ? selected : undefined
          const navigation = opens.current
          const titled = await core.mergeStored()
          const editor = editorRef.current?.noteId === shown ? editorRef.current : null
          const opened = shown
            ? await core.open(shown, editor?.vector()).catch(() => undefined)
            : undefined
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
          void core.mirrorTouch()
          await refresh(core)
          // Seen writes change no note: the other windows' marks need this read too.
          agentWrites.reload()
        }
      : undefined,
  )

  useQuickCapture(core, refresh)
  useHttpApi(core)

  const shownWrites = useRef<{ noteId: string; ids: Set<string> } | undefined>(undefined)
  // Marking runs in call order: a later note's reload must not overtake an
  // earlier note's write, or its older read can bring a dismissed notice back.
  const seenQueue = useRef<Promise<void>>(Promise.resolve())
  const reloadAgentWrites = agentWrites.reload
  const markShownSeen = useCallback(
    (options?: { reload?: boolean }) => {
      const shown = shownWrites.current
      shownWrites.current = undefined
      if (!core) return Promise.resolve()
      const next = seenQueue.current.then(() => markSeen(core, reloadAgentWrites, shown, options))
      seenQueue.current = next
      return next
    },
    [core, reloadAgentWrites],
  )

  useSaveOnHide(core)
  useSaveAtTrialEnd(editing, core, () => saveNow())

  // The other main windows wrote to the library: this one loads its lists and the notes it holds again, as for a change from another process.
  useEffect(() => {
    const reload = coalesced(
      () => window.dispatchEvent(new CustomEvent(DB_CHANGED)),
      LISTS_RELOAD_MS,
    )
    const listening = lists.link.listen(reload)
    return () => void listening.then((stop) => stop())
  }, [lists])

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
    setBuiltIn(undefined)
    const open = startOpening(id)
    await saveEdits(core)
    // Another note's body is asked for before its title, so it has usually
    // arrived with the title and shows in the same frame. A body later than
    // the title is left to the editor, which keeps the note on screen until then.
    const another = id !== selected
    let body: Uint8Array | undefined
    if (another) {
      void core.hold(id)
      core.open(id).then(
        (opened) => {
          body = opened.state
        },
        () => undefined,
      )
    }
    // A link may point at a note that is gone; leave the selection alone then.
    const name = await core.title(id).catch((e: unknown) => {
      console.warn('W_NOTE_OPEN_FAILED', id, errorCode(e))
      return undefined
    })
    const overtaken = open !== opens.current
    if (another && (overtaken || name === undefined || !body)) void core.unhold(id)
    if (overtaken) return false
    if (name === undefined) {
      stopOpening()
      return false
    }
    if (body) handOver({ core, noteId: id, state: body })
    setTakesKeyboard(keyboard || paletteFromEditor.current ? id : undefined)
    // Titles from other windows apply to this note from now on, before the render that selects it.
    shownNote.current = id
    setSelected(id)
    const relayed = openingTitle.current
    setTitle(relayed?.noteId === id ? relayed.title : name)
    if (!fromTrail) moveTrail(visit(trailRef.current, id))
    // A note opened outside the workspace (a note link, a search over every
    // note, the palette) leaves it.
    // A note just made is not listed in this render yet: it was made in the view shown.
    const opened = notes.find((n) => n.id === id) ?? templates.find((n) => n.id === id)
    if (workspaceIds && opened && !(opened.bookId && workspaceIds.has(opened.bookId))) {
      setWorkspace(null)
    }
    return true
  }

  useEffect(() => {
    if (!firstNoteWanted.current || !workspaceIds || libraryBook?.id !== workspace) return
    const open = notes.find((n) => n.id === selected)
    const first = groups.pinned[0] ?? groups.others[0]
    if ((open?.bookId && workspaceIds.has(open.bookId)) || !first) {
      firstNoteWanted.current = false
      return
    }
    const timer = setTimeout(() => {
      firstNoteWanted.current = false
      void select(first.id)
    })
    return () => clearTimeout(timer)
  })

  // Nothing is saved until the last state is restored, so a loading window never overwrites it.
  const [restored, setRestored] = useState(false)
  const warmed = useRef(false)
  useEffect(() => {
    if (!core || !restored || warmed.current) return
    warmed.current = true
    warmUp(core)
  }, [core, restored])
  const mirror = useMarkdownMirror(core, restored && primary)
  const {
    saveNow,
    editorPlaced,
    previewScrolled,
    restoreKeyboard,
    takeEditorPlace,
    takePreviewScroll,
  } = useLastState({
    store: lastStateStore,
    saved: lastState,
    core,
    listsLoaded,
    restored,
    setRestored,
    view: {
      library,
      filter,
      workspace,
      inTrash,
      inTemplates,
      bookId: libraryBook?.id,
      activeFilter,
      mode,
      selected,
      workspaceId: workspaceNode?.id,
      layouts,
    },
    lists: { books, tags, notes, templates },
    query,
    setLibrary,
    setFilter,
    setWorkspace,
    select,
  })
  useQuitAndClose({
    core,
    coreRef,
    primary,
    quitGuard,
    closeGuard,
    saveNow,
    markShownSeen,
    setSaveNoticeDismissed,
    setQuitHeld,
    setCloseHeld,
  })

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
    if (!editing) return
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
    if (pending.kind === 'savedSearch') {
      return void (await changeBooks((c) => c.deleteSavedSearch(pending.id)))
    }
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
   * Shows a note just made (`listed`: lists reloaded since). If the view would not list it, the view that does shows instead: its notebook, All Notes or Templates, without filter or search.
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
    const latest = searchState.latestSearch.current
    if (latest.query.trim()) {
      const { found } = await c
        .search(latest.query, latest.scope)
        .catch(() => ({ found: [], capped: false }))
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

  const newNoteBookId = () =>
    notebookForNewNote(
      libraryBook?.id,
      editorSettings().defaultNotebook,
      books.map((b) => b.id),
    )

  const create = async () => {
    if (!core) return
    const early = startEarlyKeys()
    let id: string
    try {
      // Save pending titles first, so the refreshed list shows them.
      await saveEdits(core)
      id = inTemplates ? await core.createTemplate() : await core.create('', newNoteBookId())
    } catch (e) {
      early.fail()
      setChangeNotice(errorCode(e))
      return
    }
    early.claim(id)
    if (!inTemplates) track('note.created', { from: 'new_note' })
    await showMade(core, id, await refresh(core))
    // A new note is for typing: Preview alone would leave it without an editor.
    if (mode === 'preview') setMode(editorMode.current)
    await select(id, { keyboard: true })
  }

  /** Makes a note from a template and opens it (see `showMade`); the template's notebook, if any, wins over the one shown. */
  const createFromTemplate = async (templateId: string) => {
    setPicking(undefined)
    if (!core || !editing) return
    await saveEdits(core)
    const id = await core
      .applyTemplate(templateId, Date.now(), newNoteBookId())
      .catch((e: unknown) => {
        setChangeNotice(errorCode(e))
        return undefined
      })
    if (!id) return console.warn('W_TEMPLATE_APPLY_FAILED', templateId)
    recentTemplates.use(templateId)
    track('note.created', { from: 'template' })
    // Its body, status and tags are written before the lists reload.
    await saveEdits(core)
    await showMade(core, id, await refresh(core))
    if (mode === 'preview') setMode(editorMode.current)
    await select(id, { keyboard: true })
  }

  /** Finds or makes today's note (dailyNotes.ts) and opens it; one outside the workspace leaves it. */
  const openToday = async () => {
    if (!core) return
    await saveEdits(core)
    let opened: { id: string; created: boolean; bookId: string | null }
    try {
      opened = await core.openTodaysNote(dailySettings(), Date.now(), editing)
    } catch (e) {
      setChangeNotice(errorCode(e))
      return
    }
    if (opened.created) track('note.created', { from: 'today' })
    if (workspaceIds && !(opened.bookId !== null && workspaceIds.has(opened.bookId))) {
      setWorkspace(null)
    }
    await showMade(core, opened.id, await refresh(core))
    if (opened.created && mode === 'preview') setMode('edit')
    await select(opened.id, { keyboard: true })
  }

  /** Fills the open note from a template without making a new one; the open editor takes in the core's writes like another process's. */
  const fillFromTemplate = async (templateId: string, noteId: string) => {
    setPicking(undefined)
    if (!core || !editing) return
    await saveEdits(core)
    const navigation = opens.current
    const editor = editorRef.current?.noteId === noteId ? editorRef.current : null
    const done = await core
      .applyTemplateTo(templateId, noteId, Date.now())
      .then(() => true)
      .catch((e: unknown) => {
        setChangeNotice(errorCode(e))
        return false
      })
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

  const setNoteDates = useStable(
    async (id: string, dates: { createdAt?: number; updatedAt?: number }) => {
      if (!core) return
      await core.setNoteDates(id, dates)
      await refresh(core)
    },
  )

  const editBuiltInCopy = async (id: string) => {
    if (!core || !editing) return
    await saveEdits(core)
    const copy = await core.saveTemplate(id, {}).catch(() => undefined)
    if (!copy) return console.warn('W_TEMPLATE_COPY_FAILED', id)
    setBuiltIn(undefined)
    await showMade(core, copy, await refresh(core))
    await select(copy, { keyboard: true })
  }
  const useBuiltIn = (id: string) => {
    if (!editing) return
    setBuiltIn(undefined)
    return createFromTemplate(id)
  }
  const showBuiltIn = useStable((id: string) => {
    setSelected(undefined)
    setBuiltIn(id)
  })
  const shownBuiltIn = selected === undefined && inTemplates ? builtIn : undefined

  const duplicate = async (id: string) => {
    if (!core) return
    await saveEdits(core)
    const tagIds = [...notes, ...templates].find((n) => n.id === id)?.tagIds
    const copy = await core.duplicate(id, t('note.copySuffix'), tagIds).catch((e: unknown) => {
      const code = errorCode(e)
      console.warn('W_NOTE_DUPLICATE_FAILED', id, code)
      setChangeNotice(code)
    })
    if (!copy) return
    if (!templates.some((n) => n.id === id)) track('note.created', { from: 'duplicate' })
    await showMade(core, copy, await refresh(core))
    await select(copy)
  }

  /** Targets for the `[[` popup: search results, or the first notes of the list for no query. Runs on every key, so it saves nothing and takes no more than the popup shows. */
  const findLinkTargets = async (linkQuery: string) => {
    if (!core) return []
    const found = linkQuery
      ? (await core.search(linkQuery, undefined, { flush: false })).found
      : await core.list(MAX_LINK_NOTES + 1)
    const targets = found.filter((n) => n.id !== selected)
    const named = await displayTitles(loadHeadlines, targets.slice(0, MAX_LINK_NOTES))
    return targets.map((n) => ({ ...n, title: named.get(n.id) ?? n.title }))
  }

  /**
   * New Note from Selection: the selection becomes a note (titled after its first line, in the open note's notebook) and a link replaces it as one undo step.
   * If the link cannot go in (text edited meanwhile, another note opened), the new note is deleted again.
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
    // Edits save after a short delay (a title just typed, the link put in):
    // write them first, or the reload shows the notes as last stored.
    await saveEdits(core)
    await refresh(core)
  }

  /**
   * New Note from Link: the link at the caret becomes a note titled after its text, with the link's address as first line, and a note link replaces it as one undo step.
   * If the link cannot be replaced (edited meanwhile, another note opened), the new note is deleted again.
   */
  const noteFromLink = async (sourceId: string) => {
    const editor = editorRef.current
    const link = editor?.linkAtCursor()
    if (!core || !editor || !link) return
    let made: string | undefined
    const moved = await editor.moveRange(link.from, link.to, async () => {
      // Named in the same write: the lists read right after show the title.
      const note = await core.extract(sourceId, link.href, link.text).catch((e: unknown) => {
        console.warn('W_NOTE_EXTRACT_FAILED', sourceId, errorCode(e))
      })
      if (!note) return null
      made = note.id
      return noteLink(note.title, note.id)
    })
    if (made === undefined) return
    if (moved) {
      track('note.created', { from: 'link' })
    } else {
      const dropped = made
      console.warn('W_NOTE_EXTRACT_NOT_LINKED', sourceId, dropped)
      await dropNote(core, dropped)
    }
    // Edits save after a short delay (a title just typed, the link put in):
    // write them first, or the reload shows the notes as last stored.
    await saveEdits(core)
    await refresh(core)
  }

  /** Saves first, so the note window reads what this window shows. */
  const openNoteWindow = async (id: string) => {
    if (core) await saveEdits(core)
    await invoke('note_window_open', { id }).catch((e: unknown) => {
      const code = errorCode(e)
      console.warn('W_NOTE_WINDOW_OPEN_FAILED', id, code)
      setChangeNotice(code)
    })
  }

  const closeNote = async () => {
    if (core) await saveEdits(core)
    setMulti(undefined)
    setBuiltIn(undefined)
    setSelected(undefined)
  }

  const dropNote = (c: Core, id: string) =>
    c
      .trash(id)
      .then(() => c.purge(id))
      .catch(() => console.warn('W_NOTE_DROP_FAILED', id))

  const createLinkedNote = async (linkTitle: string) => {
    if (!core) throw new Error('E_CORE_NOT_READY')
    const id = await core.create(linkTitle, newNoteBookId())
    await refresh(core)
    return id
  }

  const discardLinkedNote = async (id: string) => {
    if (!core) return
    await dropNote(core, id)
    await refresh(core)
  }

  const typedTitle = useRef<{ id: string; title: string }>(undefined)
  const typedTitleTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const retitleListed = useCallback(
    (id: string, named: string) => {
      setNotes((list) => retitled(list, id, named))
      setTemplates((list) => retitled(list, id, named))
      setResults((shown) => {
        const found = shown && retitled(shown.found, id, named)
        return shown && found !== shown.found ? { ...shown, found: found! } : shown
      })
    },
    [setResults],
  )
  const listTypedTitle = useCallback(() => {
    clearTimeout(typedTitleTimer.current)
    const typed = typedTitle.current
    typedTitle.current = undefined
    if (typed) retitleListed(typed.id, typed.title)
  }, [retitleListed])
  // A note window's changes: its core takes them in, and the lists show its saves and titles.
  useEffect(() => {
    if (!core) return
    const listening = relay.link.listen((message) => {
      relay.gate.heard(message.noteId)
      void core
        .relayIn(message)
        .then(() => {
          if (message.kind === 'saved' || message.kind === 'title') {
            window.dispatchEvent(new CustomEvent(NOTES_LOADED, { detail: message.noteId }))
          }
        })
        .catch((e: unknown) => {
          console.warn('W_NOTE_RELAY_IN_FAILED', message.noteId, errorCode(e))
        })
      if (message.kind === 'saved') {
        if (message.authored) authorshipChanged()
        // A note made there (a `[[` link to a new note) is not listed yet.
        if (knownNotes.current.has(message.noteId)) {
          showWrites(new Map([[message.noteId, message.updatedAt]]))
        } else void refresh(core).catch(() => {})
        void core.mirrorTouch()
      } else if (message.kind === 'title') {
        retitleListed(message.noteId, message.title)
      }
    })
    return () => void listening.then((stop) => stop())
  }, [core, relay, showWrites, retitleListed, refresh, authorshipChanged])
  useEffect(() => () => clearTimeout(typedTitleTimer.current), [])
  const rename = (next: string) => {
    if (!core || !selected) return
    // One line, cut to the longest title storage takes, as the core does:
    // a long paste never stops the note from saving.
    const clean = clipTitle(next)
    setTitle(clean)
    if (typedTitle.current && typedTitle.current.id !== selected) listTypedTitle()
    typedTitle.current = { id: selected, title: clean }
    clearTimeout(typedTitleTimer.current)
    typedTitleTimer.current = setTimeout(listTypedTitle, LIST_TITLE_MS)
    void core.setTitle(selected, clean)
  }

  /** Runs a notebook change, then reloads the lists; a refused change is logged by code and shown in a notice. */
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

  // Allow AI Access on or off for several notebooks, each its own write: a
  // notebook that fails does not stop the rest, and the notice offers Undo.
  const applyAiAccess = useStable((changes: readonly AiAccessChange[]) => {
    setAiAccessPicker(false)
    if (!core || !editing || changes.length === 0) return
    const failed: AiAccessChange[] = []
    void (async () => {
      setChangeNotice(undefined)
      reloadsPending.current += 1
      try {
        await saveEdits(core)
        for (const change of changes) {
          try {
            await core.setBookAiAccess(change.id, change.on)
          } catch (e) {
            failed.push(change)
            console.warn('W_AI_ACCESS_FAILED', change.id, errorCode(e))
          }
        }
        await saveEdits(core)
        await refresh(core)
      } finally {
        reloadsPending.current -= 1
      }
      const applied = changes.filter((change) => !failed.includes(change))
      if (applied.length === 0 && failed.length === 0) return
      setAiAccessResult({ changes: applied, failed: failed.length })
    })()
  })
  const undoAiAccess = useStable(() => {
    const result = aiAccessResult
    if (!result) return
    setAiAccessResult(undefined)
    applyAiAccess(inverseChanges(result.changes))
  })

  // Settings > Integrations leaves a flag in the storage both windows share,
  // then focuses the main window (opening one if needed): the picker opens here.
  useEffect(() => {
    // Before the core is ready there is no notebook tree to pick from.
    if (!core) return
    const check = () => {
      try {
        if (localStorage.getItem(CHOOSE_AI_ACCESS) === null) return
        localStorage.removeItem(CHOOSE_AI_ACCESS)
      } catch {
        return
      }
      setAiAccessPicker(true)
    }
    check()
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [core])
  const createBook = (parentId: string | null) =>
    changeBooks(async (c) => {
      const id = await c.createBook(t('book.new'), parentId)
      showLibraryRef.current?.({ kind: 'book', id })
      setRenamingBook(id)
    })

  const deleteBook = (id: string) => {
    const family = bookWithDescendants(books, id)
    const showsGone = library.kind === 'book' && family.has(library.id)
    const workspaceGone = workspace !== null && family.has(workspace)
    return changeBooks(async (c) => {
      await c.removeBook(id)
      if (!showsGone) return
      // The notebook the view showed went: inside a workspace the view falls back to its All Notes,
      // and only the workspace's own notebook going leaves it.
      if (workspaceNode && !workspaceGone) showLibrary({ kind: 'book', id: workspaceNode.id })
      else showLibrary({ kind: 'all' })
    })
  }

  const moveNote = (noteId: string, bookId: string | null) =>
    changeBooks((c) => c.setBook(noteId, bookId))
  // Status changes on a board view, however made (drops, keys, menus, the editor), are kept per view, in memory, so Undo and Redo on a board take back or make again the last one.
  const boardMoves = useRef<ReturnType<typeof createBoardHistories>>(undefined)
  const boardHistory = () => (boardMoves.current ??= createBoardHistories()).forView(listView)
  const recordStatus = (ids: readonly string[], status: NoteStatus) => {
    if (canBoard && editing) boardHistory().record(moveChanges(boardNotes, ids, status))
  }
  const setStatus = (noteId: string, status: NoteStatus) => {
    recordStatus([noteId], status)
    return changeBooks((c) => c.setStatus(noteId, status))
  }
  const selectedTags = (selectedNote?.tagIds ?? []).flatMap(
    (id) => tags.find((tag) => tag.id === id) ?? [],
  )
  // The services the title field and the header pickers use, so undo, sync and saving are theirs.
  const applyFrontMatter = (change: FrontMatterChange) => {
    if (!selected) return
    if (change.field === 'title') return rename(change.value)
    if (change.field === 'status') return void setStatus(selected, change.value)
    const { add, remove } = tagChanges(selectedTags, change.value)
    void changeBooks(async (c) => {
      for (const name of add) await c.addTag(selected, name)
      for (const tagId of remove) await c.removeTag(selected, tagId)
    })
  }
  const previewFields =
    selectedNote && !selectedIsTemplate
      ? {
          title,
          status: selectedNote.status,
          tags: selectedTags.map((tag) => tag.name),
          tagColors: tags.flatMap(({ name, color }) => (color ? [{ name, color }] : [])),
          canApply: editing,
        }
      : undefined

  /** One change to several notes, note by note (each its own write); failures are logged by code and counted in a notice, the rest keep their change. Resolves to the notes whose write failed. `notice` false leaves the notice to the caller, so a move over several statuses counts all its failures once. */
  const batchFailures = async (
    ids: readonly string[],
    change: BatchChange,
    options?: { notice?: boolean },
  ): Promise<string[]> => {
    if (!core) return [...ids]
    if (ids.length === 0) return []
    const notice = options?.notice !== false
    if (notice) setBatchFailed(undefined)
    reloadsPending.current += 1
    try {
      await saveEdits(core)
      const result = await core.batch([...ids], change).catch((e: unknown) => ({
        changed: [],
        failed: ids.map((id) => ({ id, code: errorCode(e) })),
      }))
      if (result.failed.length > 0) {
        console.warn('W_BATCH_FAILED', change.kind, result.failed.length, result.failed[0]?.code)
        if (notice) setBatchFailed(result.failed.length)
      }
      await saveEdits(core)
      await refresh(core)
      return result.failed.map((f) => f.id)
    } finally {
      reloadsPending.current -= 1
    }
  }
  const runBatch = async (ids: readonly string[], change: BatchChange) => {
    await batchFailures(ids, change)
  }
  // Every named note gets the write even if it seems to have the value: the lists may lag a change just made (a quick second P unpins again).
  const moveNotes = (ids: readonly string[], bookId: string | null) =>
    runBatch(ids, { kind: 'book', bookId })
  const setNotesStatus = (ids: readonly string[], status: NoteStatus) => {
    recordStatus(ids, status)
    return runBatch(ids, { kind: 'status', status })
  }
  const setNotesPinned = (ids: readonly string[], pinned: boolean) =>
    runBatch(ids, { kind: 'pinned', pinned })

  /** Makes `changes`, resolving to those that were written. */
  const applyMove = async (changes: BoardMove): Promise<BoardMove> => {
    if (changes.length === 0) return changes
    setMovedTo((shown) => new Map([...shown, ...changes.map((c) => [c.id, c.to] as const)]))
    const failed: string[] = []
    try {
      for (const [status, ids] of changesByStatus(changes)) {
        failed.push(...(await batchFailures(ids, { kind: 'status', status }, { notice: false })))
      }
      // One notice for the whole move, with every card whose write failed.
      if (failed.length > 0) setBatchFailed(failed.length)
      return appliedChanges(changes, failed)
    } catch (e) {
      console.warn('W_BOARD_MOVE_FAILED', errorCode(e))
      return []
    } finally {
      setMovedTo((shown) => {
        const left = new Map(shown)
        for (const c of changes) if (left.get(c.id) === c.to) left.delete(c.id)
        return left
      })
    }
  }
  const recordMove = (changes: BoardMove) => {
    if (!editing || changes.length === 0) return
    const history = boardHistory()
    history.record(changes)
    void applyMove(changes).then((applied) => {
      if (applied.length < changes.length) history.settle(changes, applied)
    })
  }
  const moveCards = useStable((ids: readonly string[], status: NoteStatus) =>
    recordMove(moveChanges(boardNotes, ids, status)),
  )
  const stepCards = useStable((ids: readonly string[], by: 1 | -1) =>
    recordMove(stepChanges(boardNotes, ids, boardStatusList, by)),
  )
  const undoMove = useStable(() => {
    if (!editing) return
    const changes = boardHistory().undo((move) => undoChanges(move, boardNotes))
    if (changes) void applyMove(changes)
  })
  const redoMove = useStable(() => {
    if (!editing) return
    const changes = boardHistory().redo((move) => redoChanges(move, boardNotes))
    if (changes) void applyMove(changes)
  })
  const changeLayout = useStable((layout: ListLayout) =>
    setLayouts((shown) => withLayout(shown, libraryView, layout)),
  )
  const layoutKeyboard = useRef(false)
  const changeLayoutFromControl = useStable((layout: ListLayout, keyboard: boolean) => {
    layoutKeyboard.current = keyboard && layout !== shownLayout
    changeLayout(layout)
  })
  const layoutTakesKeyboard = useCallback(() => {
    const takes = layoutKeyboard.current
    layoutKeyboard.current = false
    return takes
  }, [])
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
    setMultiIn((m) => (m?.selection.ids.some((id) => ids.includes(id)) ? undefined : m))
  }
  const restoreNotes = async (ids: readonly string[]) => {
    await runBatch(ids, { kind: 'restore' })
    setSelected(undefined)
    setMulti(undefined)
  }
  const showHistory = async (id: string | undefined) => {
    if (!id || inTrash) return
    if (id !== selected) await select(id)
    setHistoryFor(id)
  }
  useHistoryMenu(() => void (multiIds === undefined && showHistory(selected)))
  // The sheet belongs to the open note: another note or the Trash closes it
  // for good (also when opening the note failed).
  if (historyFor !== undefined && (historyFor !== selected || inTrash)) {
    setHistoryFor(undefined)
  }
  const historyBarShown = useEditorSetting('historyBar')
  const countsShown = useEditorSetting('showCounts') && mode !== 'preview'
  const [editorCounts] = useState(() => countsStore())
  const outlineSetting = useEditorSetting('outline')
  const [caretLine] = useState(() => lineStore())
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
  const authorshipShown = useEditorSetting('authorship')
  // A restored version, an accepted AI edit or a plugin write reaches the editor only while it
  // still shows the note it was made for.
  const applyToOpenNote = useStable((noteId: string, update: Uint8Array) => {
    if (editorRef.current?.noteId === noteId) restoreRef.current?.(update)
  })
  useCliAppend(core, refresh, applyToOpenNote, dailySettings)
  const historyBar = useHistoryBar({
    core,
    noteId: selected,
    updatedAt: selectedNote?.updatedAt,
    text: openText,
    enabled: historyBarShown && !inTrash && multiIds === undefined,
    readOnly: !editing,
    onApply: applyToOpenNote,
    onRestored: () => editorRef.current?.focus(),
  })

  // Authorship (ADR 0007): the open note's unseen agent writes, seen once the owner leaves the
  // note, closes the window or dismisses the notice.
  const noticeNote =
    core && selected !== undefined && !inTrash && multiIds === undefined && !selectedIsTemplate
      ? selected
      : undefined
  const openUnseen = useMemo(
    () => unseenOf(agentWrites.view, noticeNote),
    [agentWrites.view, noticeNote],
  )
  useEffect(() => {
    if (shownWrites.current && shownWrites.current.noteId !== noticeNote) markShownSeen()
    if (noticeNote === undefined || openUnseen.length === 0) return
    shownWrites.current ??= { noteId: noticeNote, ids: new Set() }
    for (const row of openUnseen) shownWrites.current.ids.add(row.writeId)
  }, [noticeNote, openUnseen, markShownSeen])
  useEffect(() => {
    const seen = () => void markShownSeen()
    window.addEventListener('pagehide', seen)
    return () => window.removeEventListener('pagehide', seen)
  }, [markShownSeen])
  const [undoDropped, setUndoDropped] = useState(false)
  /** Undo All for one writer on the note, as an owner edit the editor takes as one undo step. */
  const undoAgent = async (noteId: string, writer: WriterRef) => {
    if (!core || !editing) return
    try {
      const undone = await core.undoAgentWrites(noteId, writer)
      if (editorRef.current?.noteId === noteId) restoreRef.current?.(undone.update)
      if (undone.dropped > 0) setUndoDropped(true)
      await saveEdits(core)
      reloadAgentWrites()
    } catch (e) {
      console.warn('W_AUTHORSHIP_UNDO_FAILED', noteId, errorCode(e))
      setChangeNotice(errorCode(e))
    }
  }
  const [clearing, setClearing] = useState<string>()
  const clearNoteAuthorship = async (noteId: string) => {
    setClearing(undefined)
    if (!core || !editing) return
    try {
      const update = await core.clearAuthorship(noteId)
      if (editorRef.current?.noteId === noteId) editorRef.current.takeState(update)
      await saveEdits(core)
      reloadAgentWrites()
    } catch (e) {
      console.warn('W_AUTHORSHIP_CLEAR_FAILED', noteId, errorCode(e))
      setChangeNotice(errorCode(e))
    }
  }
  const authorshipNotice =
    noticeNote !== undefined && openUnseen.length > 0 ? (
      <AuthorshipNotice
        key={noticeNote}
        unseen={openUnseen}
        written={agentWrites.view.byNote.get(noticeNote) ?? []}
        editor={editorRef}
        canReview={mode !== 'preview'}
        editing={editing}
        onUndoAll={(writer) => undoAgent(noticeNote, writer)}
        onDismiss={markShownSeen}
      />
    ) : null
  const find = useFind({
    mode,
    noteOpen: !!core && selected !== undefined && !inTrash && !multiIds,
    editing,
    editor: editorFind,
    preview: previewFind,
  })
  const listedNotes = useMemo(() => [...notes, ...templates], [notes, templates])
  /** Runs an export, print or copy (exporter.ts, loaded on first use); a failure is shown with its code in a notice. */
  const runExport = async (
    failure: ExportFailure,
    run: (exporter: typeof import('./exporter')) => Promise<ExportReport | null | void>,
  ) => {
    if (!core) return
    setExportNotice(undefined)
    try {
      const report = await run(await import('./exporter'))
      const problem = report?.problems[0]
      if (report && problem) {
        console.warn('W_EXPORT_INCOMPLETE', problem.code)
        setExportNotice({
          failure: 'partial',
          code: problem.code,
          values: { written: report.notes, problems: report.problems.length },
        })
      }
    } catch (error) {
      const code = errorCode(error)
      console.warn('W_EXPORT_FAILED', code)
      setExportNotice({ failure, code })
    }
  }
  const exportNote = async (action: ExportAction, id: string) => {
    if (action === 'print' || action === 'exportPdf') setPageSetupFor({ action, id })
    else await runExport(failureOf(action), (exporter) => exporter.runNoteExport(core!, action, id))
  }
  /** Remembers the page setup (Rust lays the page out by it), then prints. */
  const printWith = (setup: PageSetup) => {
    if (!pageSetupFor) return
    const { action, id } = pageSetupFor
    setPageSetupFor(undefined)
    void runExport(failureOf(action), async (exporter) => {
      // Rust lays the page out by the settings it holds: when the setup cannot be saved, printing
      // would use the old one, so the export stops and its notice names the code.
      await changeEditorSettings(setup).catch((e: unknown) => {
        console.warn('W_EDITOR_SETTINGS_SAVE_FAILED', errorCode(e))
        throw e
      })
      await exporter.runNoteExport(core!, action, id)
    })
  }
  const exportBook = (action: 'exportMarkdown' | 'exportHtml', id: string) =>
    runExport('export', (exporter) => exporter.runBookExport(core!, action, id))
  const exportNotes = (action: 'exportMarkdown' | 'exportHtml', ids: readonly string[]) =>
    runExport('export', (exporter) => exporter.runSelectionExport(core!, action, ids))
  const exportAll = (action: 'exportMarkdown' | 'exportHtml') =>
    runExport('export', (exporter) => exporter.runAllExport(core!, action))
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
    openWindow: openNoteWindow,
    exportNote,
    exportNotes,
    copyFailed: (failure, code) => setExportNotice({ failure, code }),
    move: moveNotes,
    setPinned: setNotesPinned,
    setStatus: setNotesStatus,
    stepStatus: boardShown && editing ? stepCards : undefined,
    addTag: addTagToNotes,
    putTag: putTagOnNotes,
    removeTag: removeTagFromNotes,
    trash: trashNotes,
    clearAuthorship: editing ? setClearing : undefined,
    authored: (id) => agentWrites.view.authored.has(id),
  })

  // Back/Forward entries skip deleted notes (the Trash's notes are never entries); templates are entries. The open note is the current entry's or the one a navigation is opening; none in the Trash.
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
  /** Opens the next or previous note, stepping on from one a navigation is opening; from the editor it takes the keyboard there. */
  const openListed = (by: -1 | 1) => {
    const id = adjacentNote(listedIds, openingRef.current ?? selected, by)
    if (id === undefined) return
    if (!inTrash) return select(id, { keyboard: inEditor(document.activeElement) })
    startOpening(id)
    setMulti(undefined)
    setSelected(id)
  }
  /** Return or Cmd+Return on a list row: edit the open note's title or body (opening the row's note first). An editor still loading takes the keyboard when loaded. */
  const editNote = async (part: 'title' | 'body', id: string, start = false) => {
    const body = part === 'body'
    setMulti(undefined)
    if (id !== selected) {
      if (!(await select(id, { keyboard: body }))) return
    } else if (body && !editorRef.current) setTakesKeyboard(id)
    if (body && mode === 'preview') setMode(editorMode.current)
    requestFocus({ kind: part, id, start })
  }

  /** The editor could not open its note (gone or in the Trash): close it, so no editor shows a stale title and empty body. */
  const closeUnopenable = useStable((id: string, code: string) => {
    console.warn('W_NOTE_OPEN_FAILED', id, code)
    if (id === selected) setSelected(undefined)
  })

  /** One note left is the open note alone; with several, the open note stays open while selected, else the anchor opens (`openAfter`). Undefined (Escape) goes back to the open note alone. */
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

  const moveArea = (by: 1 | -1, from = areaOf(document.activeElement)) => {
    const targets = areaTargets(editorRef.current)
    const to = nextArea(from, by, (area) => targets[area] !== undefined)
    if (to) targets[to]?.()
  }
  usePaneTab(moveArea)
  useFocusRescue(() => editorRef.current)

  // Focus mode hides the sidebar too, so showing it leaves focus mode. A hiding sidebar with the keyboard hands it to the list; shown from the list header toggle, the sidebar takes it.
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
    if (document.activeElement?.closest('.sidebar-toggle')) {
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
  // The menu item is shared by the main windows, so the one in front says what it shows.
  useEffect(() => {
    if (!hasDesktopShell) return
    const say = () =>
      void invoke('sidebar_menu_set', { shown: sidebarShown }).catch(() =>
        console.warn('W_SIDEBAR_MENU_SET_FAILED'),
      )
    say()
    window.addEventListener('focus', say)
    return () => window.removeEventListener('focus', say)
  }, [sidebarShown])

  // A requested keyboard move, once the window has rendered what it needs: an area, or a note's title/body once that note is open (a loading editor takes it itself, `editNote`).
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
  }, [paletteDone])
  useMenuEvent('devot://show-palette', SHOW_PALETTE, () => openPalette())

  // Cmd+E: editor and preview swap; from split, the pane that has the
  // keyboard is the one that stays.
  const previewKeyEcho = useRef(-Infinity)
  const modeKeyboard = useRef<'editor' | 'preview' | undefined>(undefined)
  useLayoutEffect(() => {
    const to = modeKeyboard.current
    modeKeyboard.current = undefined
    if (to === 'editor') editorRef.current?.focus()
    else if (to === 'preview') document.querySelector<HTMLElement>('main .preview')?.focus()
  }, [mode])
  const [modeSeen, setModeSeen] = useState(mode)
  const modeChange = useRef<{ from: Mode; before: ModeBoxes } | null>(null)
  if (modeSeen !== mode) {
    modeChange.current = { from: modeSeen, before: measureModePanes() }
    setModeSeen(mode)
  }
  useLayoutEffect(() => {
    const change = modeChange.current
    modeChange.current = null
    if (change) playModeChange(change.from, modeSeen, change.before)
  }, [modeSeen])
  const layoutSeen = useRef({ view: listView, layout: shownLayout })
  useLayoutEffect(() => {
    const was = layoutSeen.current
    layoutSeen.current = { view: listView, layout: shownLayout }
    if (was.view === listView && was.layout !== shownLayout) fadeInListBody()
  }, [listView, shownLayout])
  const togglePreview = () => {
    const from = document.activeElement
    const next =
      mode === 'split'
        ? from?.closest('.preview')
          ? 'preview'
          : editorMode.current
        : editorOnly(mode)
          ? 'preview'
          : editorMode.current
    if (next !== mode) {
      if (editorOnly(mode) && inEditor(from)) modeKeyboard.current = 'preview'
      else if (mode === 'preview' && from?.closest('.preview')) modeKeyboard.current = 'editor'
    }
    setMode(next)
  }
  useMenuEvent('devot://toggle-preview', TOGGLE_PREVIEW, () => {
    // The key reaches the menu too; the window already ran the command.
    if (performance.now() >= previewKeyEcho.current) togglePreview()
  })
  useMenuEvent('devot://show-split', SHOW_SPLIT, () => setMode('split'))

  const openNote = selected !== undefined && !inTrash && !multiIds ? selectedNote : undefined
  const plugins = usePlugins(core, {
    openNote: () => openNote,
    applyUpdate: applyToOpenNote,
    importBook: () => libraryBook?.id ?? null,
    imported: () => {
      if (core) void refresh(core)
    },
  })
  // A saved search runs in the search field: over every note, or over the workspace open.
  const runSavedSearch = useStable((id: string) => {
    const search = savedSearches.find((s) => s.id === id)
    if (!search) return
    if (workspaceNode) showLibrary({ kind: 'book', id: workspaceNode.id }, { clearFilter: true })
    else if (inTrash || inTemplates) showLibrary({ kind: 'all' })
    setSearchIn(workspaceNode ? 'view' : 'all')
    setQuery(search.query)
    setRanSearch(id)
  })
  // The field runs a saved search when it holds its query over what that one searches: every note, or the workspace.
  const searchesSaved =
    searchScope === undefined
      ? !workspaceNode
      : !searchScope.filter && searchScope.bookId === (workspaceNode?.id ?? null)
  // The row clicked, while the field still holds its query; else the first row with that query.
  const typedQuery = query.trim()
  const activeSearch =
    searching && searchesSaved
      ? (
          savedSearches.find((s) => s.id === ranSearch && s.query === typedQuery) ??
          savedSearches.find((s) => s.query === typedQuery)
        )?.id
      : undefined
  const saveSearch = useStable(() => {
    const typed = query.trim()
    if (typed) {
      setSearchDialog({ name: clipChars(typed, MAX_SAVED_SEARCH_NAME_CHARS).trim(), query: typed })
    }
  })
  const sidebarEditSavedSearch = useStable((id: string) => {
    const search = savedSearches.find((s) => s.id === id)
    if (search) setSearchDialog({ id, name: search.name, query: search.query })
  })
  const sidebarRenameSavedSearch = useStable(
    (id: string, name: string) => void changeBooks((c) => c.renameSavedSearch(id, name)),
  )
  const sidebarPlaceSavedSearch = useStable(
    (id: string, targetId: string, where: 'before' | 'after') =>
      void changeBooks((c) => c.placeSavedSearch(id, targetId, where)),
  )
  const sidebarDeleteSavedSearch = useStable((id: string) =>
    setConfirm({
      kind: 'savedSearch',
      id,
      name: savedSearches.find((s) => s.id === id)?.name ?? '',
    }),
  )
  const finishSearchDialog = (change: { name: string; query: string }) => {
    const open = searchDialog
    setSearchDialog(undefined)
    if (!open) return
    const { id } = open
    // As the core will keep it, so the field and the sidebar's highlight agree with the row.
    const saved = savedQueryText(change.query, tags)
    if (id === undefined) {
      if (open.query === query.trim() && saved !== query.trim()) setQuery(saved)
      return void changeBooks((c) => c.createSavedSearch(change.name, saved))
    }
    // The search field running it follows its new query.
    if (id === activeSearch && saved !== open.query) {
      setQuery(saved)
      setRanSearch(id)
    }
    void changeBooks(async (c) => {
      await c.renameSavedSearch(id, change.name)
      await c.setSavedSearchQuery(id, saved)
    })
  }
  const showSearchFieldMenu = useContextMenu('searchField', SEARCH_FIELD_MENU, () => saveSearch())
  const openSearchFieldMenu = useStable((at: MenuPoint) => {
    if (editing) void showSearchFieldMenu({ query }, at)
  })
  const handlers = appHandlers(
    {
      coreReady: core !== undefined,
      query,
      sidebarShown,
      syncScroll,
      historyBarShown,
      outlineShown,
      authorshipShown,
      listDates,
      mirrorOn: mirror.status.folder !== null,
      inWorkspace: workspaceNode !== undefined,
      updateReady: updates.status.state === 'ready',
      focus,
      inTrash,
      inTemplates,
      trash,
      selected,
      multiIds,
      selectedNotes,
      listedIds,
      listedSet,
      shownSelection,
      canBoard,
      boardShown,
      canGallery,
      galleryShown,
      canGoBack: backAt !== undefined,
      canGoForward: forwardAt !== undefined,
      hasNext: nextId !== undefined,
      hasPrevious: previousId !== undefined,
      builtIn,
      openNote,
      selectedIsTemplate,
      tree,
      mode,
      palette: {
        open: paletteOpen,
        inTable: paletteInTable,
        selection: paletteSelection,
        link: paletteLink,
        image: paletteImage,
      },
      findCommands: find.commands,
    },
    {
      openPalette,
      startSearch,
      saveSearch,
      toggleFocus,
      toggleSidebar: () => {
        sidebarKeyEcho.current = performance.now() + MENU_ECHO_MS
        toggleSidebar()
      },
      focusArea: (area) => requestFocus({ kind: 'area', area }),
      moveArea: (by) => moveArea(by),
      showLibrary: (next) => showLibrary(next),
      showBackups,
      exportAll,
      rebuildIndex,
      chooseMirror: mirror.choose,
      turnOffMirror: mirror.turnOff,
      pickAiAccess: () => setAiAccessPicker(true),
      leaveWorkspace,
      sortAnchor: () => sortButtonRef.current,
      showOrder: listOrder.show,
      askEmptyTrash: () => setConfirm({ kind: 'empty' }),
      trashAction,
      restoreNotes,
      confirmDeleteMany,
      runOn: noteActions.runOn,
      runNoteAction: noteActions.run,
      setNotesStatus,
      changeSelection,
      changeLayout,
      stepCards,
      create,
      createBook,
      closeNote,
      step,
      openListed,
      pickTemplate: () => setPicking({ recent: recentTemplates.load() }),
      openToday,
      quickTag: setQuickTagNote,
      setStatus,
      setMode,
      togglePreview: () => {
        previewKeyEcho.current = performance.now() + MENU_ECHO_MS
        togglePreview()
      },
      editor: () => editorRef.current,
      noteFromSelection,
      noteFromLink,
      setImageSize,
    },
  )
  const commands = editing ? handlers : withoutChanges(handlers)
  useWindowCommands(commands)
  useFormatMenu(commands)
  useCommandMenu()
  useMenuEvent('devot://open-today', OPEN_TODAY, () => void commands['note.today']?.run())

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

  const stableOpenWorkspace = useStable((id: string) => openWorkspace(id))
  const actionsOfEntry = (entry: PaletteEntry) =>
    paletteActions(entry, {
      commands,
      editing,
      openNote,
      selectedIsTemplate,
      selected,
      inTrash,
      query,
      runPlugin: plugins.act,
      showLibrary: (next) => showLibrary(next),
      openWorkspace: stableOpenWorkspace,
      moveNote,
      showFilter,
      changeQuery,
      putTagOnNotes,
      editor: () => editorRef.current,
      select: (id) => select(id),
    })

  // Props for the memoized list and sidebar stay the same between renders, so typing in a note renders neither.
  const toggleSidebarNow = useStable(toggleSidebar)
  const sidebarToggle = useMemo(
    () => <SidebarToggle shown={sidebarShown} onClick={toggleSidebarNow} />,
    [sidebarShown, toggleSidebarNow],
  )
  const changeQueryStable = useStable((next: string) => changeQuery(next))
  const clearSearchStable = useStable(() => clearSearch())
  const filterField = useMemo(
    () => (
      <SearchField
        ref={searchField}
        value={query}
        onChange={changeQueryStable}
        onClear={clearSearchStable}
        onOptions={editing ? openSearchFieldMenu : undefined}
        placeholder={inView ? t('search.placeholder') : t('search.placeholderAll')}
      />
    ),
    [
      searchField,
      query,
      inView,
      editing,
      changeQueryStable,
      clearSearchStable,
      openSearchFieldMenu,
    ],
  )
  const layoutControl = useMemo(
    () =>
      canBoard || canGallery ? (
        <LayoutControl
          layout={shownLayout}
          layouts={canBoard ? LAYOUTS_WITH_BOARD : LAYOUTS_WITHOUT_BOARD}
          view={listView}
          onChange={changeLayoutFromControl}
          takesKeyboard={layoutTakesKeyboard}
        />
      ) : undefined,
    [canBoard, canGallery, shownLayout, listView, changeLayoutFromControl, layoutTakesKeyboard],
  )
  const openFromList = useStable((id: string) => void select(id))
  const createFromList = useStable(() => void create())
  const runNoteAction = useStable((action: NoteAction, id: string) => noteActions.run(action, id))
  const showNoteMenu = useStable((id: string, at?: MenuPoint) => noteActions.menu(id, at))
  const findInView = useStable(() => startSearch('view'))
  const findEverywhere = useStable(() => startSearch('all'))
  const findAgain = useStable(() => startSearch(searchIn))
  const editFromList = useStable((part: 'title' | 'body', id: string) => void editNote(part, id))
  const changeListSelection = useStable(changeSelection)
  const openTrashed = useStable((id: string) => {
    setMulti(undefined)
    setSelected(id)
  })
  // Hand-offs that arrive close together run one after another, so the second finds the notebook the
  // first made instead of making another with the same name.
  const handoffWork = useRef<Promise<void>>(Promise.resolve())
  const runHandoff = async (link: Extract<DeepLink, { kind: 'import' }>) => {
    const c = coreRef.current
    if (!c) {
      void finishImport(link.scan.id)
      return
    }
    try {
      // The notebooks as storage has them now, not as the last render showed them.
      const listed = await c.listBooks()
      const to = openDestination(link.notebook, listed, editorSettings().defaultNotebook)
      const destination = to.kind === 'create' ? await c.createBook(to.name, null) : to.id
      const report = await startImport(link.scan, destination, () => {}, { wikiLinks: true })
      const id = report ? firstImported(report.noteIds, link.scan.files, link.first) : undefined
      if (!id) {
        setLinkNotice('importFailed')
        return
      }
      if (!report?.bookId) showLibraryRef.current?.({ kind: 'all' }, { clearFilter: true })
      void select(id)
    } catch {
      void finishImport(link.scan.id)
      setLinkNotice('importFailed')
    }
  }
  const importHandedOver = (link: Extract<DeepLink, { kind: 'import' }>) => {
    handoffWork.current = handoffWork.current.then(() => runHandoff(link))
    return handoffWork.current
  }
  // Links other apps open (devot://note/<id>, devot://command/<id>), once the window has restored its view; sheets hold them back.
  useDeepLinks(restored && core !== undefined, (link) => {
    setLinkNotice(undefined)
    if (link.kind === 'licence') {
      licenceLink.handle(link)
      return
    }
    if (link.kind === 'import') {
      if (editing) void importHandedOver(link)
      else setLinkNotice('commandUnavailable')
      return
    }
    if (link.kind === 'today') {
      const handler = commands['note.today']
      if (handler) return Promise.resolve(handler.run())
      setLinkNotice('commandUnavailable')
      return
    }
    if (link.kind === 'command') {
      const handler = commands[link.id]
      if (handler) void handler.run()
      else setLinkNotice('commandUnavailable')
      return
    }
    const id = link.id
    const target = noteTarget(id, {
      listed: listedSet,
      notes,
      templates,
      trash,
    })
    if (target.kind === 'missing') {
      // Not in the lists (yet: another writer may have made it a moment
      // ago, before the window took the change in): ask the core.
      core?.title(id).then(
        () => {
          showLibraryRef.current?.({ kind: 'all' }, { clearFilter: true })
          void select(id)
        },
        () => setLinkNotice('noteNotFound'),
      )
      return
    }
    if (target.kind === 'trash') {
      if (!inTrash) showLibrary({ kind: 'trash' })
      openTrashed(id)
      return
    }
    if (target.kind === 'library') showLibrary({ kind: target.library }, { clearFilter: true })
    void select(id)
  })
  const trashKey = useStable((action: TrashAction, id: string) => void trashAction(action, id))
  const askEmptyTrash = useStable(() => {
    if (trash.length > 0 && editing) setConfirm({ kind: 'empty' })
  })
  // aria-disabled, not disabled: a disabled button would drop the keyboard
  // when the Trash is emptied from it.
  const showTrashMenu = useTrashMenu((action, target) => void trashAction(action, target.id))
  const trashRowMenu = useStable(
    (id: string) =>
      void showTrashMenu({
        id,
        count: multiIds?.includes(id) ? multiIds.length : 1,
      }),
  )
  const emptyTrashButton = useMemo(
    () => (
      <button
        type="button"
        className="button"
        data-tauri-drag-region="false"
        aria-disabled={trash.length === 0 || !editing}
        onClick={askEmptyTrash}
      >
        {t('trash.empty')}
      </button>
    ),
    [trash.length, editing, askEmptyTrash],
  )
  // Stable, so a Copy ID that fails does not render the Sidebar with every save.
  const sidebarCopyFailed = useStable((failure: ExportFailure, code: string) =>
    setExportNotice({ failure, code }),
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
  const sidebarSetBookIcon = useStable(
    (id: string, icon: string | null, color: TagColor | null) =>
      void changeBooks((c) => c.setBookIcon(id, icon, color)),
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
    (id: string, color: TagColorValue | null) => void changeBooks((c) => c.setTagColor(id, color)),
  )
  const [headerTagSettings, setHeaderTagSettings] = useState<string>()
  const removeOpenTag = useStable(
    (tagId: string) =>
      void (selected !== undefined && changeBooks((c) => c.removeTag(selected, tagId))),
  )
  const runChipAction = useStable((action: ChipAction, chip: ChipMenuTarget) => {
    switch (action) {
      case 'settings':
        return setHeaderTagSettings(chip.tagId)
      case 'remove':
        return removeOpenTag(chip.tagId)
      case 'filter':
        return sidebarFilter(chip.filtered ? null : { kind: 'tag', tagId: chip.tagId })
      case 'copyId':
        return void copyText(chip.tagId).catch((e: unknown) => {
          const code = errorCode(e)
          console.warn('W_TAG_COPY_FAILED', chip.tagId, code)
          setExportNotice({ failure: 'copyId', code })
        })
    }
  })
  const showChipMenu = useContextMenu('noteTag', CHIP_MENU, runChipAction)
  const runNotebookAction = useStable((action: NotebookAction, book: NotebookMenuTarget) => {
    switch (action) {
      case 'open':
        return sidebarSelect({ kind: 'book', id: book.bookId })
      case 'copyId':
        return void copyText(book.bookId).catch((e: unknown) => {
          const code = errorCode(e)
          console.warn('W_BOOK_COPY_FAILED', book.bookId, code)
          setExportNotice({ failure: 'copyId', code })
        })
    }
  })
  const showNotebookMenu = useContextMenu('noteBook', NOTEBOOK_MENU, runNotebookAction)
  const headerTag = tags.find((tag) => tag.id === headerTagSettings)
  const sidebarSearchBooks = useStable(() => openPalette('book'))
  const sidebarSearchTags = useStable(() => openPalette('tag'))
  const sidebarNewNote = useStable(() => {
    if (inTrash) showLibrary({ kind: 'all' })
    void create()
  })
  const sidebarWorkspaceUp = useStable(() => workspaceUp())
  const sidebarDeleteTag = useStable((id: string) =>
    setConfirm({
      kind: 'tag',
      id,
      name: tags.find((tag) => tag.id === id)?.name ?? '',
      count: notes.filter((n) => n.tagIds.includes(id)).length,
    }),
  )

  const filterTag =
    activeFilter?.kind === 'tag' ? tags.find((tag) => tag.id === activeFilter.tagId) : undefined
  const shownBookIcon = libraryBook ? bookIcon(libraryBook) : undefined
  const iconKey =
    activeFilter?.kind === 'tag'
      ? `tag:${filterTag?.color ?? ''}`
      : activeFilter?.kind === 'status'
        ? `status:${activeFilter.status}`
        : activeFilter?.kind === 'pinned'
          ? 'pinned'
          : activeFilter?.kind === 'agent'
            ? 'agent'
            : shownBookIcon
              ? `book:${shownBookIcon.iconColor ?? ''}:${shownBookIcon.icon ?? ''}`
              : ''
  const quickTagKey = commandKeys('note.quickTag')[0]
  const quickTagShortcut = quickTagKey ? shortcutLabel(quickTagKey) : undefined
  const listIcon = useMemo(() => {
    // The rest is a stored notebook icon, which can hold a colon itself (`lucide:leaf`).
    const [kind, a, ...rest] = iconKey.split(':')
    if (kind === 'tag') {
      const color = (a || null) as TagColorValue | null
      return (
        <span
          className={`headline-dot${color ? ` ${tagColorClass(color)}` : ''}`}
          style={tagColorStyle(color)}
        />
      )
    }
    if (kind === 'status') {
      const icon = STATUSES.find((s) => s.status === a)?.icon ?? 'status.none'
      return <Icon name={icon} size="title" />
    }
    if (kind === 'pinned') return <Icon name="notes.pinned" size="title" />
    if (kind === 'agent') return <Icon name="notebook.ai" size="title" />
    if (kind === 'book')
      return (
        <BookIcon
          icon={rest.join(':') || null}
          color={(a || null) as TagColor | null}
          size="title"
        />
      )
    return null
  }, [iconKey])
  const menuKey =
    activeFilter?.kind === 'tag'
      ? `tag:${activeFilter.tagId}`
      : !activeFilter && libraryBook
        ? `book:${libraryBook.id}`
        : ''
  const listTitleMenu = useMemo(() => {
    const [kind, id] = menuKey.split(/:(.*)/s)
    if (!kind || !id) return undefined
    return (at: MenuPoint) =>
      kind === 'tag' ? sidebarMenus.current?.tag(id, at) : sidebarMenus.current?.book(id, at)
  }, [menuKey])

  if (startFailure) return <StartFailure code={startFailure} onRetry={retryStart} />

  return (
    <div
      className="window"
      data-focus={focus || undefined}
      data-ready={restored || undefined}
      data-sidebar-hidden={sidebarOff || undefined}
      data-narrow={narrow || undefined}
      data-board={boardShown || undefined}
      data-gallery={galleryShown || undefined}
    >
      <ToolTips />
      <Sidebar
        total={workspaceNode ? (counts.get(workspaceNode.id) ?? 0) : notes.length}
        tree={sidebarTree}
        counts={counts}
        selection={
          searchingAll ? null : libraryBook || inTrash || inTemplates ? library : ALL_NOTES
        }
        renaming={renamingBook}
        onSelect={sidebarSelect}
        onCreateBook={core && editing ? sidebarCreateBook : undefined}
        onRenameBook={sidebarRenameBook}
        onRenameDone={sidebarRenameDone}
        onMoveBook={sidebarMoveBook}
        onPlaceBook={sidebarPlaceBook}
        onSetAiAccess={sidebarSetAiAccess}
        onSetBookIcon={sidebarSetBookIcon}
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
        agents={agents}
        tags={sidebarTags}
        tagCounts={sidebarTagged}
        onRenameTag={sidebarRenameTag}
        onSetTagColor={sidebarSetTagColor}
        onDeleteTag={sidebarDeleteTag}
        templatesCount={templates.length}
        trashCount={trash.length}
        onSearchBooks={sidebarSearchBooks}
        onSearchTags={sidebarSearchTags}
        onEmptyTrash={askEmptyTrash}
        onCopyFailed={sidebarCopyFailed}
        onNewNote={core && editing ? sidebarNewNote : undefined}
        readOnly={!editing}
        workspace={sidebarWorkspace}
        onOpenWorkspace={stableOpenWorkspace}
        onWorkspaceUp={sidebarWorkspaceUp}
        menus={sidebarMenus}
        savedSearches={savedSearchRows}
        activeSearch={activeSearch}
        onRunSavedSearch={runSavedSearch}
        onRenameSavedSearch={sidebarRenameSavedSearch}
        onEditSavedSearch={sidebarEditSavedSearch}
        onDeleteSavedSearch={sidebarDeleteSavedSearch}
        onPlaceSavedSearch={sidebarPlaceSavedSearch}
      />
      {galleryShown ? (
        <NoteGallery
          editing={editing}
          view={listView}
          title={
            searching
              ? (savedSearches.find((s) => s.id === activeSearch)?.name ?? t('search.results'))
              : (filterLabel ?? libraryBook?.name ?? t('sidebar.allNotes'))
          }
          icon={searching ? undefined : listIcon}
          onTitleMenu={searching ? undefined : listTitleMenu}
          empty={searching ? 'search' : activeFilter ? 'filter' : libraryBook ? 'notebook' : 'all'}
          filter={filterField}
          scope={
            searching
              ? format(t('search.in'), { view: viewName })
              : filterLabel !== undefined
                ? libraryBook?.name
                : undefined
          }
          notes={galleryNotes}
          capped={searching && (results?.capped ?? false)}
          selected={selected}
          opening={switching ? openingId : undefined}
          onSelect={openFromList}
          onCreate={core && editing ? createFromList : undefined}
          onAction={runNoteAction}
          onMenu={showNoteMenu}
          sort={sortButton}
          sortButtonRef={sortButtonRef}
          layout={layoutControl}
          onFind={searching ? findAgain : findInView}
          onEdit={editFromList}
          leading={sidebarToggle}
          selection={shownSelection}
          onSelection={changeListSelection}
          headlines={loadHeadlines}
          previews={loadCardPreviews}
          draggable={editing}
        />
      ) : searching ? (
        <NoteList
          editing={editing}
          view={listView}
          title={savedSearches.find((s) => s.id === activeSearch)?.name ?? t('search.results')}
          filter={filterField}
          scope={results?.search.scope ? format(t('search.in'), { view: viewName }) : undefined}
          highlight={highlight}
          onFind={findAgain}
          empty="search"
          pinned={NO_NOTES}
          notes={shownResults}
          capped={results?.capped ?? false}
          tags={tagsById}
          selected={selected}
          opening={switching ? openingId : undefined}
          onSelect={openFromList}
          onCreate={core && editing ? createFromList : undefined}
          onAction={runNoteAction}
          onMenu={showNoteMenu}
          sort={sortButton}
          sortButtonRef={sortButtonRef}
          onEdit={editFromList}
          leading={sidebarToggle}
          selection={shownSelection}
          onSelection={changeListSelection}
          headlines={loadHeadlines}
          details={loadDetails}
          activity={loadStrips}
          changedBy={agentWrites.view.changedBy}
          drag={editing ? 'notes' : false}
        />
      ) : inTrash ? (
        <NoteList
          editing={editing}
          view={listView}
          title={t('sidebar.trash')}
          icon={<Icon name="trash" size="title" />}
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
          details={loadDetails}
          drag={false}
          onFind={findEverywhere}
          onTrashAction={trashKey}
          onMenu={trashRowMenu}
          leading={sidebarToggle}
          headerAction={emptyTrashButton}
        />
      ) : inTemplates ? (
        <NoteList
          editing={editing}
          view={listView}
          title={t('sidebar.templates')}
          icon={<Icon name="templates" size="title" />}
          empty="templates"
          filter={filterField}
          pinned={templateRows.pinned}
          notes={templateRows.others}
          tags={tagsById}
          selected={selected}
          opening={switching ? openingId : undefined}
          onSelect={openFromList}
          onCreate={core && editing ? createFromList : undefined}
          createLabel={t('templates.new')}
          onAction={runNoteAction}
          onMenu={showNoteMenu}
          sort={sortButton}
          sortButtonRef={sortButtonRef}
          onFind={findEverywhere}
          onEdit={editFromList}
          leading={sidebarToggle}
          selection={shownSelection}
          onSelection={changeListSelection}
          headlines={loadHeadlines}
          details={loadDetails}
          drag={editing ? 'templates' : false}
          after={<BuiltInTemplates selected={shownBuiltIn} onSelect={showBuiltIn} />}
        />
      ) : boardShown ? (
        <NoteBoard
          editing={editing}
          view={listView}
          title={filterLabel ?? libraryBook?.name ?? t('sidebar.allNotes')}
          icon={listIcon}
          onTitleMenu={listTitleMenu}
          empty={activeFilter ? 'filter' : libraryBook ? 'notebook' : 'all'}
          filter={filterField}
          scope={filterLabel !== undefined ? libraryBook?.name : undefined}
          notes={boardNotes}
          statuses={boardStatusList}
          tags={tagsById}
          changedBy={agentWrites.view.changedBy}
          selected={selected}
          opening={switching ? openingId : undefined}
          onSelect={openFromList}
          onCreate={core && editing ? createFromList : undefined}
          onAction={runNoteAction}
          onMenu={showNoteMenu}
          sort={sortButton}
          sortButtonRef={sortButtonRef}
          layout={layoutControl}
          onFind={findInView}
          onEdit={editFromList}
          leading={sidebarToggle}
          selection={shownSelection}
          onSelection={changeListSelection}
          headlines={loadHeadlines}
          onMove={editing ? moveCards : undefined}
          onStep={editing ? stepCards : undefined}
          onUndo={undoMove}
          onRedo={redoMove}
        />
      ) : (
        <NoteList
          editing={editing}
          view={listView}
          title={filterLabel ?? libraryBook?.name ?? t('sidebar.allNotes')}
          icon={listIcon}
          onTitleMenu={listTitleMenu}
          empty={activeFilter ? 'filter' : libraryBook ? 'notebook' : 'all'}
          filter={filterField}
          scope={filterLabel !== undefined ? libraryBook?.name : undefined}
          pinned={activeFilter?.kind === 'pinned' ? NO_NOTES : groups.pinned}
          notes={activeFilter?.kind === 'pinned' ? groups.pinned : groups.others}
          tags={tagsById}
          selected={selected}
          opening={switching ? openingId : undefined}
          onSelect={openFromList}
          onCreate={core && editing ? createFromList : undefined}
          onAction={runNoteAction}
          onMenu={showNoteMenu}
          sort={sortButton}
          sortButtonRef={sortButtonRef}
          layout={layoutControl}
          onFind={findInView}
          onEdit={editFromList}
          leading={sidebarToggle}
          selection={shownSelection}
          onSelection={changeListSelection}
          headlines={loadHeadlines}
          details={loadDetails}
          activity={loadStrips}
          changedBy={agentWrites.view.changedBy}
          drag={editing ? 'notes' : false}
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
              <ToolIcon name={focus ? 'mode.focus.exit' : 'mode.focus'} />
            </button>
            <button
              type="button"
              className="tool"
              aria-label={t('command.back')}
              title={titleWithKey('command.backTitle', 'note.back')}
              disabled={backAt === undefined}
              onClick={() => void step(-1)}
            >
              <ToolIcon name="nav.back" />
            </button>
            <button
              type="button"
              className="tool"
              aria-label={t('command.forward')}
              title={titleWithKey('command.forwardTitle', 'note.forward')}
              disabled={forwardAt === undefined}
              onClick={() => void step(1)}
            >
              <ToolIcon name="nav.forward" />
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
                <ToolIcon name="more.horizontal" />
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
            onPutTag={(tagId) => void putTagOnNotes(multiIds, tagId)}
            onRemoveTag={(tagId) => void removeTagFromNotes(multiIds, tagId)}
            onCopyLinks={() => void noteActions.runOn('copyLink', multiIds)}
            onTrash={() => void trashNotes(multiIds)}
            onRestore={() => void restoreNotes(multiIds)}
            onDelete={() => confirmDeleteMany(multiIds)}
            readOnly={!editing}
            capped={searching && (results?.capped ?? false)}
          />
        ) : null}
        {core && selected && inTrash && !multiIds ? (
          <TrashView
            key={selected}
            core={core}
            noteId={selected}
            onRestore={() => void restoreTrashed(selected)}
            onDelete={(name) => setConfirm({ kind: 'one', id: selected, title: name })}
            readOnly={!editing}
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
              readOnly={switching || !editing}
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
              <div className="note-meta" inert={!editing}>
                <BookPicker
                  tree={tree}
                  value={selectedNote?.bookId ?? null}
                  onChange={(bookId) => void moveNote(selected, bookId)}
                  onMenu={(bookId, at) => void showNotebookMenu({ bookId }, at)}
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
                  onPut={(tagId) => void putTagOnNotes([selected], tagId)}
                  onRemove={(tagId) => void changeBooks((c) => c.removeTag(selected, tagId))}
                  quick={{
                    open: quickTagNote === selected,
                    onOpen: () => setQuickTagNote(selected),
                    onClose: () => setQuickTagNote(undefined),
                    counts: sidebarTagged,
                    shortcut: quickTagShortcut,
                    onCreate: async (name, color) => {
                      let created: string | undefined
                      await changeBooks(async (c) => {
                        created = await c.addTag(selected, name)
                        if (color) await c.setTagColor(created, color)
                      })
                      return created
                    },
                  }}
                  onChipMenu={(tagId, at) =>
                    void showChipMenu(
                      {
                        tagId,
                        filtered: activeFilter?.kind === 'tag' && activeFilter.tagId === tagId,
                      },
                      at,
                    )
                  }
                />
              </div>
            )}
            {find.bar}
            {authorshipNotice ? (
              // A version the history bar shows lies over the text the notice would select.
              <div className="authorship-notice-slot" inert={historyBar.overlay !== null}>
                {authorshipNotice}
              </div>
            ) : null}
            <div
              className={`panes panes-${mode}`}
              ref={panesRef}
              data-outline={outlineShown || undefined}
            >
              <NoteEditor
                core={core}
                noteId={selected}
                takePreopened={takePreopened}
                onLoading={setEditorLoading}
                autoFocus={selected === takesKeyboard}
                autoFocusIfFree={selected === restoreKeyboard.current}
                hidden={mode === 'preview'}
                write={mode === 'write'}
                onText={openText.changed}
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
                onCounts={countsShown ? editorCounts.set : undefined}
                onCaretLine={caretLine.set}
                onNewFromSelection={
                  inTrash || !editing ? undefined : () => void noteFromSelection(selected)
                }
                onAiEdit={
                  inTrash || !editing
                    ? undefined
                    : (start) => setAiEditing({ noteId: selected, start })
                }
                suggester={inTrash ? undefined : suggester}
                onSuggestFailed={setSuggestNotice}
                onNewFromLink={inTrash || !editing ? undefined : () => void noteFromLink(selected)}
                onImagesRefused={setImageNotice}
                onOpenFailed={closeUnopenable}
                onEditRefused={(_id, code) => setChangeNotice(code)}
                onChooseTemplate={
                  inTrash || !editing
                    ? undefined
                    : () => setPicking({ recent: recentTemplates.load(), into: selected })
                }
                onOpenNote={(id) => void select(id)}
                readOnly={!editing}
              />
              {editorOnly(mode) ? null : (
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
                  note={previewFields}
                  onApplyFrontMatter={editing ? applyFrontMatter : undefined}
                  onSetDates={inTrash || !core || !editing ? undefined : setNoteDates}
                  onOpenNote={(id) => void select(id)}
                  onFind={setPreviewFind}
                  onScrollPane={setPreviewPane}
                  onOpenImage={setViewing}
                  onImageMenu={showImageMenu}
                  onToggleTask={
                    editing ? (at) => void editorRef.current?.toggleTask(at) : undefined
                  }
                  initialScroll={takePreviewScroll}
                  onScroll={previewScrolled}
                />
              )}
              {outlineShown ? (
                <OutlinePanel
                  key={selected}
                  text={openText}
                  caret={caretLine}
                  mode={mode}
                  previewPane={previewPane}
                  folded={outlineFolds.current.get(selected) ?? NO_FOLDS}
                  onToggle={toggleOutlineFold}
                  onJump={jumpToHeading}
                  onLeave={() => editorRef.current?.focus()}
                />
              ) : null}
              {historyBar.overlay}
            </div>
            {countsShown ? <LiveCountsFooter store={editorCounts} /> : null}
            {historyBar.bar}
          </>
        ) : shownBuiltIn ? (
          <BuiltInTemplate
            id={shownBuiltIn}
            readOnly={!editing}
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
      {backupsOpen ? (
        <BackupsDialog onRestore={restore} onClose={closeBackups} readOnly={!editing} />
      ) : null}
      {core && runsSync(label) ? (
        <RestoreSyncChoice
          snapshot={syncSnapshot}
          onChoose={(choice) => core.syncAfterRestore(choice)}
        />
      ) : null}
      <Notices>
        <ActivationBar />
        <TrialEndedBar />
        <TrialReminder />
        {saveNoticeShown ? (
          <SaveNotice
            problems={saveProblems}
            quitHeld={quitHeld}
            closeHeld={closeHeld}
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
        <SyncNotice snapshot={syncSnapshot} />
        {exportNotice ? (
          <ExportNotice
            failure={exportNotice.failure}
            code={exportNotice.code}
            values={exportNotice.values}
            onDismiss={() => setExportNotice(undefined)}
          />
        ) : null}
        {indexState ? (
          <SearchIndexNotice
            state={indexState}
            locale={currentLocale()}
            onDismiss={() => setIndexState(undefined)}
          />
        ) : null}
        {mirror.notices}
        {updates.notice}
        {changeNotice ? (
          <ChangeNotice code={changeNotice} onDismiss={() => setChangeNotice(undefined)} />
        ) : null}
        {undoDropped ? (
          <div role="status" className="notice" data-devot-part="notice">
            <span className="notice-text">{t('authorship.undoDropped')}</span>
            <button type="button" className="button" onClick={() => setUndoDropped(false)}>
              {t('notice.dismiss')}
            </button>
          </div>
        ) : null}
        {batchFailed ? (
          <BatchNotice failed={batchFailed} onDismiss={() => setBatchFailed(undefined)} />
        ) : null}
        {aiAccessResult ? (
          <AiAccessNotice
            changes={aiAccessResult.changes}
            failed={aiAccessResult.failed}
            onUndo={undoAiAccess}
            onDismiss={() => setAiAccessResult(undefined)}
          />
        ) : null}
        {coreFailure ? (
          <CoreNotice code={coreFailure} onDismiss={() => setCoreFailure(undefined)} />
        ) : null}
        {suggestNotice ? (
          <AiSuggestNotice code={suggestNotice} onDismiss={() => setSuggestNotice(undefined)} />
        ) : null}
        {imageNotice ? (
          <ImageNotice codes={imageNotice} onDismiss={() => setImageNotice(undefined)} />
        ) : null}
        <ImageActionNotice />
        {linkNotice ? (
          <DeepLinkNotice problem={linkNotice} onDismiss={() => setLinkNotice(undefined)} />
        ) : null}
        {licenceLink.notice}
        {plugins.notice}
      </Notices>
      {mirror.dialog}
      {licenceLink.dialog}
      {plugins.sheet}
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
            command: [...commandEntries(commands, t), ...plugins.entries(openNote !== undefined)],
            source: sourceEntries(t),
            outline: paletteOutline,
            line: [],
            ...(paletteLibrary ?? NO_LIBRARY),
          }}
          actions={actionsOfEntry}
          initialScope={paletteScope}
          lineCount={commands['edit.goToLine'] ? paletteLines : 0}
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
            applyToOpenNote(historyFor, update)
            setHistoryFor(undefined)
          }}
          onClose={() => setHistoryFor(undefined)}
          readOnly={!editing}
        />
      ) : null}
      {core && aiGenerator && aiEditing && aiEditing.noteId === selected && !inTrash ? (
        <AiEditSheet
          core={core}
          generator={aiGenerator}
          noteId={aiEditing.noteId}
          start={aiEditing.start}
          onApply={(update) => applyToOpenNote(aiEditing.noteId, update)}
          onClose={() => setAiEditing(undefined)}
          locked={!licenceEntitlements.has('aiProviders')}
        />
      ) : null}
      {viewing ? <ImageViewer image={viewing} onClose={() => setViewing(null)} /> : null}
      {aiAccessPicker ? (
        <AiAccessDialog
          tree={tree}
          counts={counts}
          onApply={applyAiAccess}
          onCancel={() => setAiAccessPicker(false)}
        />
      ) : null}
      {clearing !== undefined ? (
        <ConfirmDialog
          destructive
          message={t('authorship.clearMessage')}
          detail={t('authorship.clearDetail')}
          confirm={t('authorship.clear')}
          onConfirm={() => void clearNoteAuthorship(clearing)}
          onCancel={() => setClearing(undefined)}
        />
      ) : null}
      {core && activityOpen ? (
        <Activity core={core} onClose={() => setActivityOpen(false)} />
      ) : null}
      {pageSetupFor ? (
        <PageSetupDialog
          action={pageSetupFor.action}
          onConfirm={printWith}
          onCancel={() => setPageSetupFor(undefined)}
        />
      ) : null}
      {headerTag ? (
        <TagSettingsDialog
          tag={headerTag}
          onSave={({ name, color }) => {
            if (name !== headerTag.name) sidebarRenameTag(headerTag.id, name)
            if (color !== headerTag.color) sidebarSetTagColor(headerTag.id, color)
            setHeaderTagSettings(undefined)
          }}
          onCancel={() => setHeaderTagSettings(undefined)}
        />
      ) : null}
      {searchDialog ? (
        <SavedSearchDialog
          editing={searchDialog.id !== undefined}
          name={searchDialog.name}
          query={searchDialog.query}
          onSave={finishSearchDialog}
          onCancel={() => setSearchDialog(undefined)}
        />
      ) : null}
      {confirm?.kind === 'savedSearch' ? (
        <ConfirmDialog
          destructive
          message={format(t('savedSearch.confirmDelete'), { name: confirm.name })}
          detail={t('savedSearch.deleteDetail')}
          confirm={t('savedSearchMenu.delete')}
          onConfirm={() => void runConfirmed()}
          onCancel={() => setConfirm(undefined)}
        />
      ) : confirm?.kind === 'tag' ? (
        <ConfirmDialog
          destructive
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
          destructive
          message={format(t('book.confirmDelete'), { name: confirm.name })}
          detail={bookDeleteDetail(confirm.subs, confirm.notes)}
          confirm={t('bookMenu.delete')}
          confirmFirst
          onConfirm={() => void runConfirmed()}
          onCancel={() => setConfirm(undefined)}
        />
      ) : confirm ? (
        <ConfirmDialog
          destructive
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
