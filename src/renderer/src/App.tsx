import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useActivityMenu } from './Activity'
import { areaOf, areaTargets, nextArea, usePaneTab } from './areas'
import { useKeymap } from './commands/shortcutSettings'
import { listLibrary } from './core-client'
import { useCoreSession, useCoreStart, useQuitAndClose } from './coreSession'
import { countsStore } from './CountsFooter'
import { refuseTextDrops } from './dragData'
import { useAlertMenu } from './editor/alertMenu'
import type { EditorHandle } from './editor/handle'
import { useEditorSetting } from './editorSettings'
import { DB_CHANGED } from './externalChanges'
import type { FindTarget } from './find/target'
import { useFind } from './find/useFind'
import { currentWindowLabel, isSecondaryLabel } from './focus'
import { useFocusRescue } from './focusRescue'
import { useHistoryBar } from './HistoryBar'
import { useCliAppend, useHttpApi, useQuickCapture } from './hostCalls'
import { useImageMenu, type SetImageSize } from './imageMenu'
import type { ViewedImage } from './ImageViewer'
import { currentLastStateStore } from './lastState'
import { startLicence, useEditing } from './licence'
import { useLicenceLink } from './LicenceLink'
import { coalesced, listsLink } from './mainWindows'
import { useMarkdownMirror } from './MarkdownMirror'
import { useNoteActions } from './noteActions'
import type { ApplyRestore } from './NoteEditor'
import { relayLink } from './noteRelay'
import { usePlugins } from './plugins/usePlugins'
import { useSaveAtTrialEnd, useSaveOnHide } from './saveGuards'
import { useSheets } from './sheets'
import type { Selection, SidebarMenus } from './Sidebar'
import { useStable } from './stable'
import { StartFailure } from './StartFailure'
import { runsSync, startSyncStatus, useSyncEngine, useSyncSnapshot } from './sync'
import { textStore } from './textStore'
import { ToolTips } from './ToolTips'
import { useUpdates } from './UpdateNotice'
import { useLastState } from './useLastState'
import { useSearch, useSearchRuns } from './useSearch'
import { useWarmUp } from './warmUp'
import { useFocusRequest, useRequestedFocus } from './app/focusRequest'
import { useListLoaders } from './app/listLoaders'
import { LibraryDialogs } from './app/LibraryDialogs'
import { ListPane } from './app/ListPane'
import { NotePane } from './app/NotePane'
import { useAiAccess } from './app/useAiAccess'
import { useAiEdits } from './app/useAiEdits'
import { useAppCommands } from './app/useAppCommands'
import { useAppDeepLinks } from './app/useAppDeepLinks'
import { useAuthorshipNotice, useShownWrites } from './app/useAuthorship'
import { useBoardMoves } from './app/useBoardMoves'
import { useConfirm } from './app/useConfirm'
import { useExport } from './app/useExport'
import { useExternalMerge } from './app/useExternalMerge'
import { useLibraryChanges } from './app/useLibraryChanges'
import { useLibraryLists, useNoteWindowChanges } from './app/useLibraryLists'
import { useLibrarySidebar } from './app/useLibrarySidebar'
import { useLibraryView } from './app/useLibraryView'
import { useListProps } from './app/useListProps'
import { useMode, useModeSwitch } from './app/useMode'
import { useNoteHeaderMenus } from './app/useNoteHeaderMenus'
import { useNoteHistory } from './app/useNoteHistory'
import { dailySettings, useNoteMaking } from './app/useNoteMaking'
import { useNoteOpening } from './app/useNoteOpening'
import { useOpenNote } from './app/useOpenNote'
import { useOutline } from './app/useOutline'
import { usePalette, usePaletteKeyboard, usePaletteLibrary } from './app/usePalette'
import { useListLayoutFade, usePanes, useSidebarMenu } from './app/usePanes'
import { useSavedSearches } from './app/useSavedSearches'
import { useSaveNotice } from './app/useSaveNotice'
import { useScrollEdges } from './app/useScrollEdges'
import { useSearchIndex } from './app/useSearchIndex'
import { useTitleRename } from './app/useTitleRename'
import { useTrash, useTrashList } from './app/useTrash'
import { useViewChanges } from './app/useViewChanges'
import { WindowNotices } from './app/WindowNotices'
import { WindowSheets } from './app/WindowSheets'

// Other main windows hear of this window's writes this long after the first of a burst, and load their lists this long after hearing (mainWindows.ts).
const LISTS_WROTE_MS = 250
const LISTS_RELOAD_MS = 400

export function App() {
  // The last state restores view, filter and mode at once, the open note once the lists load (lastState.ts).
  const lastStateStore = useMemo(() => currentLastStateStore(), [])
  const [lastState] = useState(() => lastStateStore.load())
  // Tooltips name the keys in effect; they follow the user's changes.
  useKeymap()
  const session = useCoreSession()
  const { core, coreRef, startFailure, coreFailure, setCoreFailure, retryStart } = session
  const loaders = useListLoaders(core)
  const { loadHeadlines } = loaders
  const searchState = useSearch(core)
  const { query, results } = searchState
  const lists = useLibraryLists({ ...searchState, listLibrary })
  const { notes, books, tags, savedSearches, trash, templates, listsLoaded, setListsLoaded } = lists
  const { refresh, showWrites, authorshipChanged } = lists
  const [builtIn, setBuiltIn] = useState<string>()
  const [selected, setSelected] = useState<string>()
  useEffect(() => refuseTextDrops(window), [])
  const modes = useMode(lastState)
  const { mode, setMode } = modes
  const editorRef = useRef<EditorHandle | null>(null)
  const panesRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const focusRequest = useFocusRequest({ editorRef, titleRef, selected })
  const { requestFocus } = focusRequest
  const panes = usePanes({ editorRef, requestFocus, startFailure })
  const { focus, narrow, sidebarOff, sidebarShown, toggleSidebar } = panes
  const opening = useNoteOpening({ selected, editorRef, panesRef })
  const { title, opens, setTitle } = opening
  const tagInputRef = useRef<HTMLInputElement>(null)
  const [quickTagNote, setQuickTagNote] = useState<string>()
  const syncSnapshot = useSyncSnapshot()
  useEffect(() => startSyncStatus(), [])
  // Re-renders when the licence changes, so what is locked follows it.
  const editing = useEditing()
  useEffect(() => startLicence(), [])
  const licenceLink = useLicenceLink()
  const [changeNotice, setChangeNotice] = useState<string>()
  const [imageNotice, setImageNotice] = useState<string[]>()
  const updates = useUpdates()
  // The open note's Markdown mirrored for the preview; not App state, so typing renders only the preview.
  const [openText] = useState(() => textStore())
  const [activityOpen, setActivityOpen] = useState(false)
  useActivityMenu(() => setActivityOpen(true))
  const restoreRef = useRef<ApplyRestore | null>(null)
  // A restored version, an accepted AI edit or a plugin write reaches the editor only while it
  // still shows the note it was made for.
  const applyToOpenNote = useStable((noteId: string, update: Uint8Array) => {
    if (editorRef.current?.noteId === noteId) restoreRef.current?.(update)
  })
  const [editorFind, setEditorFind] = useState<FindTarget | null>(null)
  const [previewFind, setPreviewFind] = useState<FindTarget | null>(null)
  const [viewing, setViewing] = useState<ViewedImage | null>(null)
  // `main` hosts what runs once (the mirror, compaction); a window File > New Window opened does not (mainWindows.ts).
  const [label] = useState(currentWindowLabel)
  const primary = !isSecondaryLabel(label)
  useSyncEngine(core, label)
  // What this window's core says to the other windows, and hears from them (noteRelay.ts).
  const [relay] = useState(() => ({ link: relayLink(label) }))
  const [windowLists] = useState(() => {
    const link = listsLink(label)
    return { link, wrote: coalesced(() => link.send(), LISTS_WROTE_MS) }
  })
  const sidebarMenus = useRef<SidebarMenus | null>(null)
  const listDates = useEditorSetting('listDates')
  const scroll = useScrollEdges({ panesRef, mode, selected })
  const { previewPane } = scroll
  const palette = usePalette(editorRef)

  const saves = useSaveNotice({ core, coreRef, refresh })
  const { onSaveProblems } = saves

  // Callbacks that outlive a render (finished import, New Notebook) change view through the latest rules (`showLibrary`).
  const showLibraryRef =
    useRef<(next: Selection, options?: { clearFilter?: boolean }) => void>(undefined)

  const sheets = useSheets({ core, coreRef, refresh, showLibraryRef })
  const { backupsOpen, backupNotice, setBackupNotice, nextSheet, startImport, showBackups } = sheets

  const view = useLibraryView({ lastState, core, lists, search: searchState, selected })
  const { library, filter, workspace, inTrash, inTemplates, libraryBook, activeFilter } = view
  const { workspaceNode, layouts, setLibrary, setFilter, setWorkspace, tree, counts } = view
  const { multiIds, selectedNote, selectedIsTemplate, agentWrites, boardShown, galleryShown } = view
  const showAlertMenu = useAlertMenu()
  const setImageSize = useCallback<SetImageSize>((source, size) => {
    editorRef.current?.setImageSize(source, size)
  }, [])
  const showImageMenu = useImageMenu(setImageSize)
  const viewChanges = useViewChanges({
    view,
    books,
    search: searchState,
    panes,
    setSelected,
    requestFocus,
    showLibraryRef,
  })

  useCoreStart(session, {
    primary,
    lists: windowLists,
    relay,
    refresh,
    nextSheet,
    onSaveProblems,
    showWrites,
    authorshipChanged,
    takeIn: opening.takeIn,
    setListsLoaded,
  })

  useSearchRuns(searchState, { scope: view.searchScope, inView: view.inView })
  const searchIndex = useSearchIndex(core, refresh)
  useExternalMerge({
    core,
    selected,
    inTrash,
    opens,
    editorRef,
    setTitle,
    refresh,
    patch: lists.patch,
    agentWrites,
  })

  useQuickCapture(core, refresh)
  useHttpApi(core)

  const shown = useShownWrites(core, agentWrites)

  useSaveOnHide(core)

  // The other main windows wrote to the library: this one loads its lists and the notes it holds again, as for a change from another process.
  useEffect(() => {
    const reload = coalesced(
      () => window.dispatchEvent(new CustomEvent(DB_CHANGED)),
      LISTS_RELOAD_MS,
    )
    const listening = windowLists.link.listen(reload)
    return () => void listening.then((stop) => stop())
  }, [windowLists])

  const open = useOpenNote({
    core,
    selected,
    setSelected,
    setBuiltIn,
    setChangeNotice,
    opening,
    lists,
    view,
    viewChanges,
    modes,
    editorRef,
    paletteFromEditor: palette.paletteFromEditor,
    requestFocus,
  })
  const { select } = open

  // Nothing is saved until the last state is restored, so a loading window never overwrites it.
  const [restored, setRestored] = useState(false)
  useWarmUp(core, restored, () => editorRef.current?.text() ?? '', view.listedIds)
  const mirror = useMarkdownMirror(core, restored && primary)
  const lastStateParts = useLastState({
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
  const { saveNow } = lastStateParts
  useSaveAtTrialEnd(editing, core, saveNow)
  useQuitAndClose({
    core,
    coreRef,
    primary,
    saveNow,
    markShownSeen: shown.markShownSeen,
    flushListsNews: windowLists.wrote.flush,
    ...saves.held,
  })

  useNoteWindowChanges({ core, relay, lists, knownNotes: view.knownNotes })
  const rename = useTitleRename({ core, selected, setTitle, retitleListed: lists.retitleListed })
  const making = useNoteMaking({
    core,
    editing,
    lists,
    view,
    searchState,
    modes,
    showLibrary: viewChanges.showLibrary,
    select,
    selected,
    setSelected,
    builtIn,
    setBuiltIn,
    setTitle,
    opens,
    editorRef,
    setChangeNotice,
    loadHeadlines,
  })
  const libraryChanges = useLibraryChanges({
    core,
    lists,
    view,
    showLibrary: viewChanges.showLibrary,
    showLibraryRef,
    setSelected,
    setChangeNotice,
  })
  const aiAccess = useAiAccess({
    core,
    editing,
    refresh,
    reloadStarted: lists.reloadStarted,
    reloadDone: lists.reloadDone,
    setChangeNotice,
    tree,
    counts,
  })
  const board = useBoardMoves({ view, editing, libraryChanges })
  const { setConfirm, dialog: confirmDialog } = useConfirm({
    trash,
    libraryChanges,
    setMulti: view.setMulti,
    setSelected,
  })
  const trashActions = useTrash({
    editing,
    trash,
    multiIds,
    loadHeadlines,
    setConfirm,
    changeBooks: libraryChanges.changeBooks,
    restoreNotes: libraryChanges.restoreNotes,
    setMulti: view.setMulti,
    setSelected,
  })
  const { showHistory, sheet: historySheet } = useNoteHistory({
    core,
    editing,
    selected,
    inTrash,
    multiIds,
    title,
    books,
    select,
    applyToOpenNote,
  })
  const historyBarShown = useEditorSetting('historyBar')
  const countsShown = useEditorSetting('showCounts') && mode !== 'preview'
  const [editorCounts] = useState(() => countsStore())
  const outline = useOutline({ panesRef, mode, selected, focus, editorRef, previewPane })
  const authorshipShown = useEditorSetting('authorship')
  const ai = useAiEdits({ core, selected, inTrash, applyToOpenNote })
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

  const authorship = useAuthorshipNotice({
    core,
    editing,
    selected,
    inTrash,
    multiIds,
    selectedIsTemplate,
    mode,
    agentWrites,
    shown,
    editorRef,
    restoreRef,
    setChangeNotice,
  })
  const find = useFind({
    mode,
    noteOpen: !!core && selected !== undefined && !inTrash && !multiIds,
    editing,
    editor: editorFind,
    preview: previewFind,
  })
  const listedNotes = useMemo(() => [...notes, ...templates], [notes, templates])
  const exports = useExport(core)
  const noteActions = useNoteActions({
    headlines: loadHeadlines,
    notes: listedNotes,
    tree,
    tags,
    selection: inTrash ? undefined : multiIds,
    duplicate: making.duplicate,
    history: showHistory,
    openWindow: open.openNoteWindow,
    exportNote: exports.exportNote,
    exportNotes: exports.exportNotes,
    copyFailed: (failure, code) => exports.setExportNotice({ failure, code }),
    move: libraryChanges.moveNotes,
    setPinned: libraryChanges.setNotesPinned,
    setStatus: board.setNotesStatus,
    stepStatus: boardShown && editing ? board.stepCards : undefined,
    addTag: libraryChanges.addTagToNotes,
    putTag: libraryChanges.putTagOnNotes,
    removeTag: libraryChanges.removeTagFromNotes,
    trash: libraryChanges.trashNotes,
    clearAuthorship: editing ? authorship.setClearing : undefined,
    authored: (id) => agentWrites.view.authored.has(id),
  })

  const moveArea = (by: 1 | -1, from = areaOf(document.activeElement)) => {
    const targets = areaTargets(editorRef.current)
    const to = nextArea(from, by, (area) => targets[area] !== undefined)
    if (to) targets[to]?.()
  }
  usePaneTab(moveArea)
  useFocusRescue(() => editorRef.current)

  const toggleSidebarCommand = useSidebarMenu({ sidebarShown, toggleSidebar })
  useRequestedFocus(focusRequest)
  usePaletteKeyboard({
    editorRef,
    paletteDone: palette.paletteDone,
    openPalette: palette.openPalette,
  })
  const togglePreviewCommand = useModeSwitch({ ...modes, editorRef })
  useListLayoutFade(view.listView, view.shownLayout)

  const openNote = selected !== undefined && !inTrash && !multiIds ? selectedNote : undefined
  const plugins = usePlugins(core, {
    openNote: () => openNote,
    applyUpdate: applyToOpenNote,
    importBook: () => libraryBook?.id ?? null,
    imported: () => {
      if (core) void refresh(core)
    },
  })
  const savedSearch = useSavedSearches({
    search: searchState,
    searching: view.searching,
    searchScope: view.searchScope,
    savedSearches,
    tags,
    workspaceNode,
    inTrash,
    inTemplates,
    editing,
    showLibrary: viewChanges.showLibrary,
    changeBooks: libraryChanges.changeBooks,
    setConfirm,
  })
  const listProps = useListProps({
    view,
    setLayouts: view.setLayouts,
    search: searchState,
    editing,
    sidebarShown,
    toggleSidebar,
    changeQuery: viewChanges.changeQuery,
    clearSearch: viewChanges.clearSearch,
    startSearch: viewChanges.startSearch,
    openSearchFieldMenu: savedSearch.openSearchFieldMenu,
    select,
    create: making.create,
    noteActions,
    editNote: open.editNote,
    changeSelection: open.changeSelection,
  })
  const appCommands = useAppCommands({
    core,
    editing,
    query,
    selected,
    mode,
    setMode,
    builtIn,
    openNote,
    trash,
    settings: {
      syncScroll: scroll.syncScroll,
      historyBarShown,
      outlineShown: outline.outlineShown,
      authorshipShown,
      listDates,
    },
    view,
    panes,
    toggleSidebarCommand,
    togglePreviewCommand,
    open,
    viewChanges,
    making,
    libraryChanges,
    board,
    trashActions,
    palette,
    find,
    mirror,
    updates,
    noteActions,
    plugins,
    changeLayout: listProps.changeLayout,
    startSearch: viewChanges.startSearch,
    saveSearch: savedSearch.saveSearch,
    showBackups,
    exportAll: exports.exportAll,
    rebuildIndex: searchIndex.rebuildIndex,
    pickAiAccess: aiAccess.pick,
    setConfirm,
    setQuickTagNote,
    requestFocus,
    moveArea,
    editorRef,
    setImageSize,
  })
  const { commands } = appCommands
  const paletteLibrary = usePaletteLibrary({
    paletteOpen: palette.paletteOpen,
    notes,
    tree,
    tags,
    loadHeadlines,
  })
  const linkNotice = useAppDeepLinks({
    ready: restored && core !== undefined,
    core,
    coreRef,
    editing,
    commands,
    licenceLink,
    startImport,
    showLibrary: viewChanges.showLibrary,
    showLibraryRef,
    select,
    openTrashed: trashActions.openTrashed,
    listedSet: view.listedSet,
    notes,
    templates,
    trash,
    inTrash,
  })
  const trashList = useTrashList({
    editing,
    trash,
    multiIds,
    trashAction: trashActions.trashAction,
    setConfirm,
  })
  const librarySidebar = useLibrarySidebar({
    core,
    editing,
    lists,
    view,
    viewChanges,
    libraryChanges,
    setNotesStatus: board.setNotesStatus,
    savedSearch,
    setConfirm,
    setExportNotice: exports.setExportNotice,
    exportBook: exports.exportBook,
    openPalette: palette.openPalette,
    create: making.create,
    askEmptyTrash: trashList.askEmptyTrash,
    menus: sidebarMenus,
  })
  const headerMenus = useNoteHeaderMenus({
    tags,
    selected,
    changeBooks: libraryChanges.changeBooks,
    setExportNotice: exports.setExportNotice,
    sidebarFilter: librarySidebar.sidebarFilter,
    sidebarSelect: librarySidebar.sidebarSelect,
    sidebarRenameTag: librarySidebar.sidebarRenameTag,
    sidebarSetTagColor: librarySidebar.sidebarSetTagColor,
  })

  if (startFailure) return <StartFailure onRetry={retryStart} />

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
      {librarySidebar.sidebar}
      <ListPane
        core={core}
        editing={editing}
        selected={selected}
        results={results}
        activeSearch={savedSearch.activeSearch}
        lists={lists}
        view={view}
        listProps={listProps}
        opening={opening}
        loaders={loaders}
        board={board}
        trashList={trashList}
        openTrashed={trashActions.openTrashed}
        making={making}
        sidebarMenus={sidebarMenus}
      />
      <NotePane
        core={core}
        editing={editing}
        selected={selected}
        mode={mode}
        setMode={setMode}
        focus={focus}
        toggleFocus={panes.toggleFocus}
        results={results}
        tags={tags}
        view={view}
        open={open}
        opening={opening}
        rename={rename}
        making={making}
        libraryChanges={libraryChanges}
        board={board}
        trashActions={trashActions}
        setConfirm={setConfirm}
        noteActions={noteActions}
        headerMenus={headerMenus}
        outline={outline}
        lastState={lastStateParts}
        find={find}
        historyBar={historyBar}
        authorshipNotice={authorship.authorshipNotice}
        quickTagNote={quickTagNote}
        setQuickTagNote={setQuickTagNote}
        titleRef={titleRef}
        tagInputRef={tagInputRef}
        panesRef={panesRef}
        editorRef={editorRef}
        restoreRef={restoreRef}
        openText={openText}
        countsShown={countsShown}
        editorCounts={editorCounts}
        previewPane={previewPane}
        setEditorPane={scroll.setEditorPane}
        setPreviewPane={scroll.setPreviewPane}
        setEditorFind={setEditorFind}
        setPreviewFind={setPreviewFind}
        showAlertMenu={showAlertMenu}
        showImageMenu={showImageMenu}
        setViewing={setViewing}
        setAiEditing={ai.setAiEditing}
        suggester={ai.suggester}
        setSuggestNotice={ai.setSuggestNotice}
        setImageNotice={setImageNotice}
        setChangeNotice={setChangeNotice}
        loadHeadlines={loadHeadlines}
      />
      <LibraryDialogs
        sheets={sheets}
        tree={tree}
        library={library}
        editing={editing}
        syncCore={runsSync(label) ? core : undefined}
        syncSnapshot={syncSnapshot}
      />
      <WindowNotices
        save={saves.notice}
        backup={{
          code: backupNotice,
          backupsOpen,
          show: showBackups,
          dismiss: () => setBackupNotice(undefined),
        }}
        syncSnapshot={syncSnapshot}
        exported={exports.notice}
        searchIndex={searchIndex.notice}
        mirror={mirror.notices}
        updates={updates.notice}
        change={{ code: changeNotice, dismiss: () => setChangeNotice(undefined) }}
        undoDropped={authorship.undoDroppedNotice}
        batch={libraryChanges.batchNotice}
        aiAccess={aiAccess.notice}
        coreFailure={{ code: coreFailure, dismiss: () => setCoreFailure(undefined) }}
        ai={ai.notice}
        images={{ code: imageNotice, dismiss: () => setImageNotice(undefined) }}
        link={linkNotice}
        licence={licenceLink.notice}
        plugins={plugins.notice}
      />
      <WindowSheets
        mirror={mirror.dialog}
        licence={licenceLink.dialog}
        plugins={plugins.sheet}
        noteActions={noteActions.dialog}
        templatePicker={making.templatePicker}
        palette={palette}
        paletteLibrary={paletteLibrary}
        commands={appCommands}
        pluginEntries={plugins.entries}
        noteOpen={openNote !== undefined}
        history={historySheet}
        ai={ai.sheet}
        viewing={viewing}
        closeViewer={() => setViewing(null)}
        aiAccess={aiAccess.dialog}
        clearAuthorship={authorship.clearDialog}
        activity={{ core, open: activityOpen, close: () => setActivityOpen(false) }}
        exported={exports.dialog}
        headerMenus={headerMenus.dialog}
        savedSearch={savedSearch.dialog}
        confirm={confirmDialog}
      />
    </div>
  )
}
