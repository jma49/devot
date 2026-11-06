import type { RefObject } from 'react'
import type { NoteSummary, TrashedNote } from '../../../core'
import type { Area } from '../areas'
import { appHandlers, type AppCommandState } from '../commands/appHandlers'
import { useCommandMenu } from '../commands/commandMenu'
import { useMenuEvent, useWindowCommands } from '../commands/dispatch'
import { useFormatMenu } from '../commands/formatMenu'
import { withoutChanges } from '../commands/registry'
import type { Core } from '../core-client'
import type { EditorHandle } from '../editor/handle'
import type { useFind } from '../find/useFind'
import type { SetImageSize } from '../imageMenu'
import type { ListLayout } from '../lastState'
import type { useMarkdownMirror } from '../MarkdownMirror'
import type { Mode } from '../ModeControl'
import type { useNoteActions } from '../noteActions'
import { paletteActions } from '../palette/appActions'
import type { PaletteEntry } from '../palette/results'
import type { usePlugins } from '../plugins/usePlugins'
import type { useUpdates } from '../UpdateNotice'
import type { useBoardMoves } from './useBoardMoves'
import type { Confirm } from './useConfirm'
import type { LibraryChanges } from './useLibraryChanges'
import type { ViewState } from './useLibraryView'
import type { useNoteMaking } from './useNoteMaking'
import type { useOpenNote } from './useOpenNote'
import type { usePalette } from './usePalette'
import type { usePanes } from './usePanes'
import type { useTrash } from './useTrash'
import type { useViewChanges } from './useViewChanges'

export const OPEN_TODAY = 'devot:open-today'

/** The window's commands (keys, menus, the palette), with those that change notes left out while editing is locked. */
export function useAppCommands({
  core,
  editing,
  query,
  selected,
  mode,
  setMode,
  builtIn,
  openNote,
  trash,
  settings: { syncScroll, historyBarShown, outlineShown, authorshipShown, listDates },
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
  changeLayout,
  startSearch,
  saveSearch,
  showBackups,
  exportAll,
  rebuildIndex,
  pickAiAccess,
  setConfirm,
  setQuickTagNote,
  requestFocus,
  moveArea,
  editorRef,
  setImageSize,
}: {
  core: Core | undefined
  editing: boolean
  query: string
  selected: string | undefined
  mode: Mode
  setMode: (mode: Mode) => void
  builtIn: string | undefined
  openNote: NoteSummary | undefined
  trash: TrashedNote[]
  settings: Pick<
    AppCommandState,
    'syncScroll' | 'historyBarShown' | 'outlineShown' | 'authorshipShown' | 'listDates'
  >
  view: ViewState
  panes: ReturnType<typeof usePanes>
  toggleSidebarCommand: () => void
  togglePreviewCommand: () => void
  open: ReturnType<typeof useOpenNote>
  viewChanges: ReturnType<typeof useViewChanges>
  making: ReturnType<typeof useNoteMaking>
  libraryChanges: LibraryChanges
  board: ReturnType<typeof useBoardMoves>
  trashActions: ReturnType<typeof useTrash>
  palette: ReturnType<typeof usePalette>
  find: ReturnType<typeof useFind>
  mirror: ReturnType<typeof useMarkdownMirror>
  updates: ReturnType<typeof useUpdates>
  noteActions: ReturnType<typeof useNoteActions>
  plugins: ReturnType<typeof usePlugins>
  changeLayout: (layout: ListLayout) => void
  startSearch: (where: 'all' | 'view') => void
  saveSearch: () => void
  showBackups: () => void
  exportAll: (action: 'exportMarkdown' | 'exportHtml') => Promise<void>
  rebuildIndex: () => Promise<void>
  pickAiAccess: () => void
  setConfirm: (confirm: Confirm) => void
  setQuickTagNote: (id: string | undefined) => void
  requestFocus: (request: { kind: 'area'; area: Area }) => void
  moveArea: (by: 1 | -1) => void
  editorRef: RefObject<EditorHandle | null>
  setImageSize: SetImageSize
}) {
  const { workspaceNode, inTrash, inTemplates, multiIds, selectedNotes, listedIds, listedSet } =
    view
  const { shownSelection, canBoard, boardShown, canGallery, galleryShown } = view
  const { selectedIsTemplate, tree, sortButtonRef, listOrder } = view
  const { sidebarShown, focus, toggleFocus } = panes
  const { backAt, forwardAt, nextId, previousId, changeSelection, closeNote, step, openListed } =
    open
  const { select } = open
  const { showLibrary, leaveWorkspace, showFilter, changeQuery, stableOpenWorkspace } = viewChanges
  const { create, setPicking, recentTemplates, openToday, noteFromSelection, noteFromLink } = making
  const { restoreNotes, createBook, moveNote, putTagOnNotes } = libraryChanges
  const { setNotesStatus, stepCards, setStatus } = board
  const { trashAction, confirmDeleteMany } = trashActions
  const { paletteOpen, paletteInTable, paletteSelection, paletteLink, paletteImage } = palette
  const { openPalette } = palette
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
    // oxlint-disable-next-line react/refs -- appHandlers only builds the table; these actions read refs when a command runs.
    {
      openPalette,
      startSearch,
      saveSearch,
      toggleFocus,
      toggleSidebar: toggleSidebarCommand,
      focusArea: (area) => requestFocus({ kind: 'area', area }),
      moveArea: (by) => moveArea(by),
      showLibrary: (next) => showLibrary(next),
      showBackups,
      exportAll,
      rebuildIndex,
      chooseMirror: mirror.choose,
      turnOffMirror: mirror.turnOff,
      pickAiAccess,
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
      togglePreview: togglePreviewCommand,
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

  return { commands, actionsOfEntry }
}
