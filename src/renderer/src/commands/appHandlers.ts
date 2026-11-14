import type { NoteStatus, NoteSummary, TrashedNote } from '../../../core'
import type { BookNode } from '../../../core/books'
import type { EditorSettings } from '../../../core/editorSettings'
import { visible, type Area } from '../areas'
import { bookOptions, currentBookOption, NO_BOOK } from '../BookPicker'
import { changeEditorSettings, editorSettings, stepEditorFontSize } from '../editorSettings'
import type { EditorHandle } from '../editor/handle'
import { LINE_COMMANDS } from '../editor/lineCommands'
import {
  IMAGE_COMMANDS,
  imageActionApplies,
  runImageAction,
  type ImageAction,
  type ImageMenuTarget,
  type SetImageSize,
} from '../imageMenu'
import type { ListLayout } from '../lastState'
import { editingAllowed } from '../licence'
import { selectAll, type ListSelection } from '../listSelection'
import { openMainWindow } from '../mainWindows'
import type { Mode } from '../ModeControl'
import {
  NOTE_COMMANDS,
  SELECTION_ONLY,
  TRASH_COMMANDS,
  type NoteAction,
  type NoteMenuAction,
  type TrashAction,
} from '../noteMenu'
import { requestGraph } from '../graph/GraphSheet'
import { requestNoteInfo } from '../noteInfo/command'
import type { PaletteSource } from '../palette/results'
import { stepSidebarRow, type Selection } from '../Sidebar'
import { STATUS_COMMANDS } from '../statusKeys'
import { restartNow } from '../UpdateNotice'
import { checkForUpdates } from '../updates'
import { COMMANDS, formatOf, insertOf, tableOf, type CommandHandlers } from './registry'

type Run = void | Promise<unknown>
type ExportAll = 'exportMarkdown' | 'exportHtml'

/** What the main window shows, as far as its commands depend on it. */
export interface AppCommandState {
  coreReady: boolean
  query: string
  sidebarShown: boolean
  syncScroll: boolean
  historyBarShown: boolean
  outlineShown: boolean
  authorshipShown: boolean
  listDates: EditorSettings['listDates']
  mirrorOn: boolean
  inWorkspace: boolean
  updateReady: boolean
  focus: boolean
  inTrash: boolean
  inTemplates: boolean
  trash: readonly TrashedNote[]
  selected: string | undefined
  multiIds: readonly string[] | undefined
  selectedNotes: readonly NoteSummary[]
  listedIds: readonly string[]
  listedSet: ReadonlySet<string>
  shownSelection: ListSelection | undefined
  canBoard: boolean
  boardShown: boolean
  canGallery: boolean
  galleryShown: boolean
  canGoBack: boolean
  canGoForward: boolean
  hasNext: boolean
  hasPrevious: boolean
  builtIn: string | undefined
  /** The note open alone, outside the Trash. */
  openNote: NoteSummary | undefined
  selectedIsTemplate: boolean
  tree: BookNode[]
  mode: Mode
  palette: {
    open: boolean
    inTable: boolean
    selection: boolean
    link: boolean
    image: ImageMenuTarget | null
  }
  findCommands: CommandHandlers
}

/** What the main window's commands do. */
export interface AppCommandActions {
  openPalette: (scope?: PaletteSource) => Run
  startSearch: (where: 'all' | 'view') => Run
  saveSearch: () => Run
  askNotes: () => Run
  toggleFocus: () => Run
  /** Show or Hide Sidebar from its key or menu item. */
  toggleSidebar: () => Run
  focusArea: (area: Area) => Run
  moveArea: (by: 1 | -1) => Run
  showLibrary: (next: Selection) => Run
  showBackups: () => Run
  exportAll: (action: ExportAll) => Run
  rebuildIndex: () => Run
  chooseMirror: () => Run
  turnOffMirror: () => Run
  pickAiAccess: () => Run
  leaveWorkspace: () => Run
  sortAnchor: () => HTMLElement | null
  showOrder: (anchor: HTMLElement) => Run
  askEmptyTrash: () => Run
  trashAction: (action: TrashAction, id: string) => Run
  restoreNotes: (ids: readonly string[]) => Run
  confirmDeleteMany: (ids: readonly string[]) => Run
  runOn: (action: NoteMenuAction, ids: readonly string[]) => Run
  runNoteAction: (action: NoteAction, id: string) => Run
  setNotesStatus: (ids: readonly string[], status: NoteStatus) => Run
  changeSelection: (next: ListSelection | undefined) => Run
  changeLayout: (layout: ListLayout) => Run
  stepCards: (ids: readonly string[], by: 1 | -1) => Run
  create: () => Run
  createBook: (parentId: string | null) => Run
  closeNote: () => Run
  step: (by: -1 | 1) => Run
  openListed: (by: -1 | 1) => Run
  pickTemplate: () => Run
  openToday: () => Run
  quickTag: (id: string) => Run
  setStatus: (id: string, status: NoteStatus) => Run
  setMode: (mode: Mode) => Run
  /** Toggle Preview from its key or menu item. */
  togglePreview: () => Run
  editor: () => EditorHandle | null
  noteFromSelection: (id: string) => Run
  noteFromLink: (id: string) => Run
  setImageSize: SetImageSize
}

const flip = (patch: (now: EditorSettings) => Partial<EditorSettings>) => () =>
  changeEditorSettings(patch(editorSettings())).catch(() =>
    console.warn('W_EDITOR_SETTINGS_SAVE_FAILED'),
  )

/** The commands the main window can run right now, before the licence takes away those that change notes. */
export function appHandlers(at: AppCommandState, act: AppCommandActions): CommandHandlers {
  const handlers: CommandHandlers = {
    'palette.open': { run: () => act.openPalette() },
    'search.view': { run: () => act.startSearch('view') },
    'search.all': { run: () => act.startSearch('all') },
    ...(at.coreReady && at.query.trim() ? { 'search.save': { run: act.saveSearch } } : {}),
    ...(at.coreReady ? { 'ai.ask': { run: act.askNotes } } : {}),
    'view.focus': { run: act.toggleFocus },
    'view.sidebar': {
      run: act.toggleSidebar,
      label: at.sidebarShown ? 'command.hideSidebar' : 'command.showSidebar',
    },
    'view.focusNoteList': { run: () => act.focusArea('list') },
    'view.nextSidebarRow': { run: () => stepSidebarRow(1) },
    'view.previousSidebarRow': { run: () => stepSidebarRow(-1) },
    'view.nextArea': { run: () => act.moveArea(1) },
    'view.previousArea': { run: () => act.moveArea(-1) },
    'view.fontBigger': { run: () => stepEditorFontSize(1) },
    'view.fontSmaller': { run: () => stepEditorFontSize(-1) },
    'view.fontReset': { run: () => stepEditorFontSize(0) },
    'view.syncScroll': {
      run: flip((now) => ({ syncScroll: !now.syncScroll })),
      label: at.syncScroll ? 'command.syncScrollOff' : 'command.syncScrollOn',
    },
    'view.historyBar': {
      run: flip((now) => ({ historyBar: !now.historyBar })),
      label: at.historyBarShown ? 'command.hideHistoryBar' : 'command.showHistoryBar',
    },
    'view.outline': {
      run: flip((now) => ({ outline: !now.outline })),
      label: at.outlineShown ? 'command.hideOutline' : 'command.showOutline',
    },
    'view.authorship': {
      run: flip((now) => ({ authorship: !now.authorship })),
      label: at.authorshipShown ? 'command.hideAuthorship' : 'command.showAuthorship',
    },
    'view.toggleListDates': {
      run: flip((now) => ({ listDates: now.listDates === 'absolute' ? 'relative' : 'absolute' })),
      label:
        at.listDates === 'absolute' ? 'command.showRelativeDates' : 'command.showAbsoluteDates',
    },
    'view.allNotes': { run: () => act.showLibrary({ kind: 'all' }) },
    'view.templates': { run: () => act.showLibrary({ kind: 'templates' }) },
    'view.trash': { run: () => act.showLibrary({ kind: 'trash' }) },
    'app.backups': { run: act.showBackups },
    'app.newWindow': { run: () => void openMainWindow() },
    'app.checkForUpdates': { run: checkForUpdates },
    'app.exportAllMarkdown': { run: () => act.exportAll('exportMarkdown') },
    'app.exportAllHtml': { run: () => act.exportAll('exportHtml') },
    'app.rebuildSearchIndex': { run: act.rebuildIndex },
    'mirror.chooseFolder': { run: act.chooseMirror },
    'notebook.aiAccessMany': { run: act.pickAiAccess },
  }
  if (at.mirrorOn) handlers['mirror.turnOff'] = { run: act.turnOffMirror }
  if (at.inWorkspace) handlers['view.leaveWorkspace'] = { run: act.leaveWorkspace }
  if (at.updateReady) handlers['app.restartToUpdate'] = { run: restartNow }
  if (!at.focus && !at.inTrash) {
    handlers['view.sort'] = {
      run: () => {
        const anchor = act.sortAnchor()
        if (visible(anchor)) return act.showOrder(anchor)
      },
    }
  }
  if (at.trash.length > 0) handlers['trash.empty'] = { run: act.askEmptyTrash }
  const { selected, multiIds } = at
  if (
    at.inTrash &&
    selected !== undefined &&
    at.trash.some((n) => n.id === selected) &&
    !multiIds
  ) {
    for (const [action, commandId] of Object.entries(TRASH_COMMANDS)) {
      handlers[commandId] = { run: () => act.trashAction(action as TrashAction, selected) }
    }
  }
  if (multiIds && at.inTrash) {
    handlers['trash.restore'] = { run: () => act.restoreNotes(multiIds), label: 'batch.restore' }
    handlers['trash.deleteForever'] = {
      run: () => act.confirmDeleteMany(multiIds),
      label: 'batch.deleteForever',
    }
  } else if (multiIds) {
    const run = (action: NoteMenuAction) => () => act.runOn(action, multiIds)
    handlers['note.move'] = { run: run('move'), label: 'batch.move' }
    handlers['note.pin'] = {
      run: run('pin'),
      label: at.selectedNotes.every((n) => n.pinned) ? 'batch.unpin' : 'batch.pin',
    }
    handlers['note.copyLink'] = { run: run('copyLink'), label: 'batch.copyLinks' }
    handlers['note.trash'] = { run: run('trash'), label: 'batch.trash' }
    if (!at.inTemplates) {
      for (const [status, commandId] of Object.entries(STATUS_COMMANDS)) {
        handlers[commandId] = { run: () => act.setNotesStatus(multiIds, status as NoteStatus) }
      }
      handlers['note.addTag'] = { run: run('addTag') }
      if (at.selectedNotes.some((n) => n.tagIds.length > 0)) {
        handlers['note.removeTag'] = { run: run('removeTag') }
      }
    }
  }
  if (!at.focus && at.listedIds.length > 1) {
    handlers['list.selectAll'] = {
      run: () => act.changeSelection(selectAll(at.shownSelection, selected, at.listedIds)),
    }
  }
  if (at.canBoard) {
    handlers['view.toggleBoard'] = {
      run: () => act.changeLayout(at.boardShown ? 'list' : 'board'),
      label: at.boardShown ? 'command.showList' : 'command.showBoard',
    }
  }
  if (at.canGallery) {
    handlers['view.toggleGallery'] = {
      run: () => act.changeLayout(at.galleryShown ? 'list' : 'gallery'),
      label: at.galleryShown ? 'command.showList' : 'command.showGallery',
    }
  }
  const boardTargets =
    multiIds ?? (selected !== undefined && at.listedSet.has(selected) ? [selected] : undefined)
  if (at.boardShown && boardTargets) {
    handlers['status.next'] = { run: () => act.stepCards(boardTargets, 1) }
    handlers['status.previous'] = { run: () => act.stepCards(boardTargets, -1) }
  }
  if (at.coreReady) {
    handlers['note.new'] = {
      run: () => {
        if (at.inTrash) act.showLibrary({ kind: 'all' })
        return act.create()
      },
    }
    handlers['notebook.new'] = { run: () => act.createBook(null) }
    if (selected !== undefined || multiIds || at.builtIn !== undefined)
      handlers['note.close'] = { run: act.closeNote }
    if (at.canGoBack) handlers['note.back'] = { run: () => act.step(-1) }
    if (at.canGoForward) handlers['note.forward'] = { run: () => act.step(1) }
    if (at.hasNext) handlers['note.next'] = { run: () => act.openListed(1) }
    if (at.hasPrevious) handlers['note.previous'] = { run: () => act.openListed(-1) }
    handlers['note.newFromTemplate'] = { run: act.pickTemplate }
    handlers['note.today'] = { run: act.openToday }
  }
  const { openNote } = at
  if (openNote && !at.selectedIsTemplate && editingAllowed()) {
    handlers['note.quickTag'] = { run: () => act.quickTag(openNote.id) }
  }
  if (openNote) addNoteHandlers(handlers, openNote, at, act)
  const trashedOne = at.inTrash && at.selected !== undefined && !at.multiIds
  if ((openNote && !at.selectedIsTemplate) || trashedOne) {
    handlers['view.noteInfo'] = { run: requestNoteInfo }
  }
  if (at.coreReady) handlers['view.graph'] = { run: requestGraph }
  // Find works while a note is open; its keys run ahead of the editor's (useFind).
  Object.assign(handlers, at.findCommands)
  if (handlers['note.move']) handlers['note.moveAnywhere'] = handlers['note.move']
  return handlers
}

function addNoteHandlers(
  handlers: CommandHandlers,
  openNote: NoteSummary,
  at: AppCommandState,
  act: AppCommandActions,
) {
  const id = openNote.id
  for (const [action, commandId] of Object.entries(NOTE_COMMANDS)) {
    if (SELECTION_ONLY.has(action as NoteAction)) continue
    if (action === 'openWindow' && at.selectedIsTemplate) continue
    handlers[commandId] = { run: () => act.runNoteAction(action as NoteAction, id) }
  }
  handlers['note.pin'] = {
    run: () => act.runNoteAction('pin', id),
    label: openNote.pinned ? 'note.unpin' : 'note.pin',
  }
  // Control+Command+1 to 5 set the open note's status. A template's own
  // status is not shown and not used (its front matter sets one).
  if (!at.selectedIsTemplate) {
    for (const [status, commandId] of Object.entries(STATUS_COMMANDS)) {
      handlers[commandId] = { run: () => act.setStatus(id, status as NoteStatus) }
    }
  }
  const bookId = currentBookOption(bookOptions(at.tree), openNote.bookId)
  if (bookId !== NO_BOOK && !at.selectedIsTemplate) {
    handlers['note.showNotebook'] = { run: () => act.showLibrary({ kind: 'book', id: bookId }) }
  }
  handlers['view.write'] = { run: () => act.setMode('write') }
  handlers['view.edit'] = { run: () => act.setMode('edit') }
  handlers['view.togglePreview'] = { run: act.togglePreview }
  handlers['view.split'] = { run: () => act.setMode('split') }
  handlers['view.preview'] = { run: () => act.setMode('preview') }
  if (at.mode === 'preview') return
  const { palette } = at
  for (const c of COMMANDS) {
    const formatId = formatOf(c.id)
    if (formatId) handlers[c.id] = { run: () => act.editor()?.format(formatId) }
    const insertId = insertOf(c.id)
    if (insertId) handlers[c.id] = { run: () => act.editor()?.insert(insertId) }
    const tableId = palette.open && palette.inTable ? tableOf(c.id) : undefined
    if (tableId) handlers[c.id] = { run: () => act.editor()?.table(tableId) }
  }
  handlers['edit.pastePlain'] = { run: () => act.editor()?.pastePlain() }
  for (const commandId of LINE_COMMANDS) {
    handlers[commandId] = { run: () => act.editor()?.runLine(commandId) }
  }
  handlers['edit.goToLine'] = { run: () => act.openPalette('line') }
  if (!at.inTrash) handlers['ai.suggest'] = { run: () => act.editor()?.suggest() }
  handlers['edit.pasteUrlAs'] = { run: () => act.editor()?.pasteUrlAs() }
  if (palette.open && palette.selection) {
    handlers['note.newFromSelection'] = { run: () => act.noteFromSelection(id) }
  }
  if (palette.open && palette.link) {
    handlers['note.newFromLink'] = { run: () => act.noteFromLink(id) }
  }
  const image = palette.open ? palette.image : null
  if (image?.fileId) handlers['image.view'] = { run: () => void act.editor()?.viewImage() }
  if (image) {
    for (const [action, commandId] of Object.entries(IMAGE_COMMANDS)) {
      if (!imageActionApplies(action as ImageAction, image)) continue
      handlers[commandId] = {
        run: () => runImageAction(action as ImageAction, image, act.setImageSize),
      }
    }
  }
}
