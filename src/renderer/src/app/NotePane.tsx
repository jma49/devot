import { useMemo, useState } from 'react'
import { Inspector } from '../outline/Inspector'
import { LazyHistory } from '../LazyHistory'
import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react'
import type { TagRecord } from '../../../core'
import { findBookNode } from '../../../core/workspace'
import type { Suggester } from '../../../core/aiSuggest'
import { BookPicker } from '../BookPicker'
import { BuiltInTemplate } from '../BuiltInTemplates'
import { shortcutLabel } from '../commands/keys'
import { commandKeys } from '../commands/registry'
import { titleWithKey } from '../commands/titles'
import type { Core } from '../core-client'
import { LiveCountsFooter, type countsStore } from '../CountsFooter'
import type { useAlertMenu } from '../editor/alertMenu'
import type { AiEditStart } from '../editor/aiMenu'
import type { EditorHandle } from '../editor/handle'
import type { FindTarget } from '../find/target'
import type { useFind } from '../find/useFind'
import { displayTitle, useHeadlines, type HeadlineLoader } from '../headlines'
import type { useHistoryBar } from '../HistoryBar'
import { t } from '../i18n'
import { ToolIcon } from '../icons/Icon'
import type { useImageMenu } from '../imageMenu'
import type { ViewedImage } from '../ImageViewer'
import { isImeKey } from '../ime'
import { ModeControl, editorOnly, type Mode } from '../ModeControl'
import type { useNoteActions } from '../noteActions'
import { NoteEditor, type ApplyRestore } from '../NoteEditor'
import type { NoteAiAccess } from '../noteInfo/NoteInfoCard'
import { LiveNoteInfoSummary } from '../noteInfo/NoteInfoSummary'
import { LivePreview } from '../preview/Preview'
import { tagChanges, type FrontMatterChange } from '../preview/frontMatterApply'
import type { ScrollPane } from '../preview/scrollSync'
import { SelectionSummary } from '../SelectionSummary'
import { StatusPicker } from '../StatusPicker'
import { TagEditor } from '../TagEditor'
import type { textStore } from '../textStore'
import { TrashView } from '../TrashView'
import { track } from '../usage'
import type { useLastState } from '../useLastState'
import type { SearchResults } from '../useSearch'
import type { useBoardMoves } from './useBoardMoves'
import type { Confirm } from './useConfirm'
import type { LibraryChanges } from './useLibraryChanges'
import type { ViewState } from './useLibraryView'
import type { useNoteHeaderMenus } from './useNoteHeaderMenus'
import type { useNoteMaking } from './useNoteMaking'
import type { NoteOpening } from './useNoteOpening'
import type { useOpenNote } from './useOpenNote'
import type { useOutline } from './useOutline'
import type { useTrash } from './useTrash'
import { EmptyNotePane } from './EmptyNotePane'

const NO_FOLDS: ReadonlySet<string> = new Set()

/** The open note's side of the window: its toolbar, header, editor, preview and outline, or what shows instead. */
export function NotePane({
  core,
  editing,
  selected,
  mode,
  setMode,
  focus,
  toggleFocus,
  results,
  view,
  open,
  opening,
  rename,
  making,
  libraryChanges,
  board,
  trashActions,
  setConfirm,
  noteActions,
  headerMenus,
  outline,
  lastState,
  find,
  historyBar,
  authorshipNotice,
  quickTagNote,
  setQuickTagNote,
  titleRef,
  tagInputRef,
  panesRef,
  editorRef,
  setEditorHandle,
  restoreRef,
  openText,
  countsShown,
  editorCounts,
  previewPane,
  setEditorPane,
  setPreviewPane,
  setEditorFind,
  setPreviewFind,
  showAlertMenu,
  showImageMenu,
  setViewing,
  setAiEditing,
  suggester,
  setSuggestNotice,
  setImageNotice,
  setChangeNotice,
  tags,
  loadHeadlines,
  openPalette,
}: {
  core: Core | undefined
  editing: boolean
  selected: string | undefined
  mode: Mode
  setMode: (mode: Mode) => void
  focus: boolean
  toggleFocus: () => void
  results: SearchResults | undefined
  view: ViewState
  open: ReturnType<typeof useOpenNote>
  opening: NoteOpening
  rename: (next: string) => void
  making: ReturnType<typeof useNoteMaking>
  libraryChanges: LibraryChanges
  board: ReturnType<typeof useBoardMoves>
  trashActions: ReturnType<typeof useTrash>
  setConfirm: (confirm: Confirm) => void
  noteActions: ReturnType<typeof useNoteActions>
  headerMenus: ReturnType<typeof useNoteHeaderMenus>
  outline: ReturnType<typeof useOutline>
  lastState: ReturnType<typeof useLastState>
  find: ReturnType<typeof useFind>
  historyBar: ReturnType<typeof useHistoryBar>
  authorshipNotice: ReactNode
  quickTagNote: string | undefined
  setQuickTagNote: Dispatch<SetStateAction<string | undefined>>
  titleRef: RefObject<HTMLInputElement | null>
  tagInputRef: RefObject<HTMLInputElement | null>
  panesRef: RefObject<HTMLDivElement | null>
  editorRef: RefObject<EditorHandle | null>
  setEditorHandle: Dispatch<SetStateAction<EditorHandle | null>>
  restoreRef: RefObject<ApplyRestore | null>
  openText: ReturnType<typeof textStore>
  countsShown: boolean
  editorCounts: ReturnType<typeof countsStore>
  previewPane: ScrollPane | null
  setEditorPane: (pane: ScrollPane | null) => void
  setPreviewPane: (pane: ScrollPane | null) => void
  setEditorFind: (target: FindTarget | null) => void
  setPreviewFind: (target: FindTarget | null) => void
  showAlertMenu: ReturnType<typeof useAlertMenu>
  showImageMenu: ReturnType<typeof useImageMenu>
  setViewing: (image: ViewedImage | null) => void
  setAiEditing: (editing: { noteId: string; start: AiEditStart }) => void
  suggester: Suggester | undefined
  setSuggestNotice: (code: string | undefined) => void
  setImageNotice: (codes: string[] | undefined) => void
  setChangeNotice: (code: string | undefined) => void
  tags: TagRecord[]
  loadHeadlines: HeadlineLoader | undefined
  openPalette: () => void
}) {
  const [infoPanel, setInfoPanel] = useState<HTMLDivElement | null>(null)
  const { inTrash, multiIds, selectedNotes, inTemplates, selectedIsTemplate, tree } = view
  const { selectedNote, activeFilter, sidebarTagged, searching } = view
  const { backAt, forwardAt, step, editNote, takesKeyboard, closeUnopenable, select } = open
  const { title, switching, takePreopened, setEditorLoading } = opening
  const untitled = useMemo(
    () => (selectedNote && title === '' ? [selectedNote] : []),
    [selectedNote, title],
  )
  const headline = useHeadlines(loadHeadlines, untitled).get(selectedNote?.id ?? '')
  const { findLinkTargets, createLinkedNote, discardLinkedNote, noteFromSelection } = making
  const { noteFromLink, setPicking, recentTemplates, setNoteDates } = making
  const { shownBuiltIn, pickBuiltIn, editBuiltInCopy } = making
  const { setNotesPinned, addTagToNotes, putTagOnNotes, removeTagFromNotes } = libraryChanges
  const { trashNotes, restoreNotes, changeBooks, moveNote } = libraryChanges
  const { setNotesStatus, setStatus } = board
  const { confirmDeleteMany, restoreTrashed } = trashActions
  const { showNotebookMenu, showChipMenu } = headerMenus
  const { outlineShown, caretLine, outlineFolds, toggleOutlineFold, jumpToHeading } = outline
  const { restoreKeyboard, takeEditorPlace, editorPlaced, takePreviewScroll, previewScrolled } =
    lastState
  const selectedTags = (selectedNote?.tagIds ?? []).flatMap(
    (id) => tags.find((tag) => tag.id === id) ?? [],
  )
  const noteBook =
    selectedNote?.bookId != null ? findBookNode(tree, selectedNote.bookId) : undefined
  const aiAccess: NoteAiAccess = noteBook
    ? {
        state: noteBook.aiAccess ? 'on' : 'off',
        onToggle: editing
          ? () => void changeBooks((c) => c.setBookAiAccess(noteBook.id, !noteBook.aiAccess))
          : undefined,
      }
    : { state: 'noBook' }
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
  const quickTagKey = commandKeys('note.quickTag')[0]
  const quickTagShortcut = quickTagKey ? shortcutLabel(quickTagKey) : undefined

  return (
    <main className="content" data-devot-part="editor" inert={making.making}>
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
          <div className="trail-history" data-tauri-drag-region="false">
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
            <span className="trail-history-divider" aria-hidden="true" />
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
            placeholder={displayTitle('', headline)}
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
            <div className="note-meta">
              <div className="note-meta-fields" inert={!editing}>
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
              {selectedNote ? (
                <LiveNoteInfoSummary
                  key={selected}
                  core={core}
                  text={openText}
                  inspectorPanel={infoPanel}
                  editor={editing && !switching ? editorRef : undefined}
                  onShowInspectorInfo={
                    outlineShown ? () => outline.tab.toggleInfo(selected) : undefined
                  }
                  info={{
                    noteId: selectedNote.id,
                    createdAt: selectedNote.createdAt,
                    updatedAt: selectedNote.updatedAt,
                  }}
                  note={previewFields}
                  onOpenNote={(id) => void select(id)}
                  onSetDates={editing ? setNoteDates : undefined}
                  onApplyFrontMatter={editing ? applyFrontMatter : undefined}
                  canLinkMentions={editing}
                  aiAccess={aiAccess}
                />
              ) : null}
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
              onHandle={setEditorHandle}
              onOpenImage={setViewing}
              showImageMenu={showImageMenu}
              initialPlace={takeEditorPlace(selected)}
              onPlace={editorPlaced}
              onCounts={countsShown ? editorCounts.set : undefined}
              onVimMode={editorCounts.setVimMode}
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
                noteId={selected}
                frontMatterInInfo={!selectedIsTemplate}
                onOpenNote={(id) => void select(id)}
                onFind={setPreviewFind}
                onScrollPane={setPreviewPane}
                onOpenImage={setViewing}
                onImageMenu={showImageMenu}
                onToggleTask={editing ? (at) => void editorRef.current?.toggleTask(at) : undefined}
                blocksEditable={editing}
                initialScroll={takePreviewScroll}
                onScroll={previewScrolled}
              />
            )}
            {outlineShown ? (
              <Inspector
                key={selected}
                noteId={selected}
                room={outline.outlineRoom}
                tab={outline.tab}
                infoRef={setInfoPanel}
                info={
                  selectedIsTemplate &&
                  selectedNote && (
                    <LiveNoteInfoSummary
                      inline
                      core={core}
                      text={openText}
                      info={{
                        noteId: selected,
                        createdAt: selectedNote.createdAt,
                        updatedAt: selectedNote.updatedAt,
                      }}
                      editor={editing && !switching ? editorRef : undefined}
                      onOpenNote={(id) => void select(id)}
                    />
                  )
                }
                history={
                  <LazyHistory
                    key={selected}
                    inline
                    shown={outline.tab.active === 'history'}
                    core={core}
                    noteId={selected}
                    title={title}
                    books={view.books}
                    updatedAt={selectedNote?.updatedAt}
                    readOnly={!editing || switching}
                    onRestore={(update) => {
                      if (editorRef.current?.noteId === selected) restoreRef.current?.(update)
                    }}
                  />
                }
                outline={{
                  text: openText,
                  caret: caretLine,
                  mode: mode,
                  previewPane: previewPane,
                  folded: outlineFolds.current.get(selected) ?? NO_FOLDS,
                  onToggle: toggleOutlineFold,
                  onJump: jumpToHeading,
                  onLeave: () => editorRef.current?.focus(),
                }}
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
          onUse={(id) => void pickBuiltIn(id)}
          onEditCopy={(id) => void editBuiltInCopy(id)}
        />
      ) : core && !selected && !inTrash && !multiIds ? (
        <EmptyNotePane
          editing={editing}
          onNewNote={() => void making.create()}
          onOpenToday={() => void making.openToday()}
          onOpenPalette={openPalette}
          onNewFromTemplate={() => making.setPicking({ recent: making.recentTemplates.load() })}
        />
      ) : null}
    </main>
  )
}
