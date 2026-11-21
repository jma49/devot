// A note in a window of its own (src-tauri/src/note_window.rs): its title, metadata pills, find
// bar, editor, preview and word counts, on a core of its own. What this window and the others
// change in the note reaches each at once (noteRelay.ts and listsLink), and each saves its own
// changes. Closing the window, and quitting, save first.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BookRecord, NoteSummary, SaveProblem, TagRecord, TakenIn } from '../../../core'
import { buildBookTree, TEMPLATES_BOOK_ID } from '../../../core/books'
import { errorCode } from '../../../core/errors'
import { clipTitle } from '../../../core/noteLimits'
import { compareNames } from '../../../core/sort'
import { NOTE_STATUSES } from '../../../core/storage'
import { BookPicker } from '../BookPicker'
import { shortcutLabel } from '../commands/keys'
import { useWindowCommands } from '../commands/dispatch'
import { commandKeys, type CommandHandlers } from '../commands/registry'
import { useKeymap } from '../commands/shortcutSettings'
import { countsStore, LiveCountsFooter } from '../CountsFooter'
import { onRestoreElsewhere } from '../backups'
import { startCore, stopCore, type Core } from '../core-client'
import { displayTitle, useHeadlines } from '../headlines'
import { useAlertMenu } from '../editor/alertMenu'
import { DB_CHANGED, notesLoaded, useExternalChanges } from '../externalChanges'
import type { FindTarget } from '../find/target'
import { useFind } from '../find/useFind'
import { t } from '../i18n'
import { useImageMenu, type SetImageSize } from '../imageMenu'
import { ImageActionNotice } from '../ImageNotice'
import { ImageViewer, type ViewedImage } from '../ImageViewer'
import { isImeKey } from '../ime'
import { invoke } from '../ipc'
import { startLicence, useEditing } from '../licence'
import { MAX_LINK_NOTES } from '../linkCompletion'
import { linkedNoteCreate, linkedNoteDiscard } from '../linkedNotes'
import { currentDefaultMode } from '../lastState'
import { coalesced, listsLink } from '../mainWindows'
import { ModeControl, editorOnly, type Mode } from '../ModeControl'
import type { EditorHandle } from '../editor/handle'
import { NoteEditor } from '../NoteEditor'
import { noteWindowLabel, relayLink } from '../noteRelay'
import { Notices } from '../Notices'
import { requestNoteInfo } from '../noteInfo/command'
import { LiveNoteInfoSummary } from '../noteInfo/NoteInfoSummary'
import { tagChanges, type FrontMatterChange } from '../preview/frontMatterApply'
import { LivePreview } from '../preview/Preview'
import { SaveNotice } from '../SaveNotice'
import {
  CLOSE_EVENT,
  FLUSH_EVENT,
  answerAsked,
  quitRound,
  saveEdits,
  type Asked,
  useSaveAtTrialEnd,
  useSaveOnHide,
  useSaveProblems,
} from '../saveGuards'
import { StatusPicker } from '../StatusPicker'
import { STATUS_COMMANDS } from '../statusKeys'
import { TagEditor } from '../TagEditor'
import { textStore } from '../textStore'
import { unlistenLater } from '../windowEvents'
import { useEditorSetting } from '../editorSettings'
import { Inspector, useInspectorTab } from '../outline/Inspector'
import { lineStore } from '../outline/lineStore'
import { LazyHistory } from '../LazyHistory'
import type { ApplyRestore } from '../NoteEditor'
import { scrollPreviewTo } from '../outline/room'
import { useOutlineRoom } from '../outline/useOutlineRoom'
import type { ScrollPane } from '../preview/scrollSync'
import { ActivationBar, TrialEndedBar } from '../TrialNotices'
import { failureText } from '../failure'
import { nextLife, type NoteLife } from './noteLife'
import { summaryAfterWrites } from './summaryWrites'

// Coalesced notifications mirror the main window cadence so bursts of tag or metadata writes batch cleanly.
const LISTS_WROTE_MS = 250
const LISTS_RELOAD_MS = 400
const EMPTY_TAG_COUNTS: ReadonlyMap<string, number> = new Map()

/** Hears what Rust asks of this window: the global quit, by its round, and the close of this window alone. */
function listenAsked(onClose: () => void, onQuit: (round: number) => void): () => void {
  const quit = (payload: unknown) => {
    const round = quitRound(payload)
    if (round === undefined) console.warn('W_EXIT_ROUND_MISSING')
    else onQuit(round)
  }
  const onQuitAsked = (e: Event) => quit((e as CustomEvent<unknown>).detail)
  window.addEventListener(CLOSE_EVENT, onClose)
  window.addEventListener(FLUSH_EVENT, onQuitAsked)
  const unlisten = DEVOT_UI_TEST
    ? undefined
    : unlistenLater(
        Promise.all([
          import('@tauri-apps/api/event'),
          import('@tauri-apps/api/webviewWindow'),
        ]).then(([{ listen }, { getCurrentWebviewWindow }]) =>
          Promise.all([
            getCurrentWebviewWindow().listen('devot://note-window-close', onClose),
            listen<unknown>('devot://flush-before-exit', ({ payload }) => quit(payload)),
          ]),
        ),
        () => console.warn('W_NOTE_WINDOW_LISTEN_FAILED'),
      )
  return () => {
    window.removeEventListener(CLOSE_EVENT, onClose)
    window.removeEventListener(FLUSH_EVENT, onQuitAsked)
    unlisten?.()
  }
}

function nameWindow(title: string) {
  document.title = title
  if (DEVOT_UI_TEST) return
  void import('@tauri-apps/api/window')
    .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title))
    .catch(() => console.warn('W_NOTE_WINDOW_TITLE_FAILED'))
}

export function NoteWindow() {
  useKeymap()
  const [core, setCore] = useState<Core>()
  const coreRef = useRef<Core | undefined>(undefined)
  const [noteId, setNoteId] = useState<string>()
  const [failure, setFailure] = useState<string>()
  const [title, setTitle] = useState('')
  const [books, setBooks] = useState<BookRecord[]>([])
  const [tags, setTags] = useState<TagRecord[]>([])
  const [noteSummary, setNoteSummary] = useState<NoteSummary>()
  const [quickTagOpen, setQuickTagOpen] = useState(false)
  const [mode, setMode] = useState<Mode>(currentDefaultMode)
  const [openText] = useState(() => textStore())
  const loadHeadlines = useMemo(
    () => (core ? (ids: string[]) => core.headlines(ids) : undefined),
    [core],
  )
  const untitled = useMemo(
    () => (noteSummary && title === '' ? [noteSummary] : []),
    [noteSummary, title],
  )
  const headline = useHeadlines(loadHeadlines, untitled).get(noteSummary?.id ?? '')
  const editorRef = useRef<EditorHandle | null>(null)
  const tagInputRef = useRef<HTMLInputElement>(null)
  const panesRef = useRef<HTMLDivElement>(null)
  const listsWroteRef = useRef<ReturnType<typeof coalesced> | undefined>(undefined)
  const aliveRef = useRef(true)
  const metaSeqRef = useRef(0)
  const [caretLine] = useState(() => lineStore())
  const [previewPane, setPreviewPane] = useState<ScrollPane | null>(null)
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set())
  const [editorFind, setEditorFind] = useState<FindTarget | null>(null)
  const [previewFind, setPreviewFind] = useState<FindTarget | null>(null)
  const [editorCounts] = useState(() => countsStore())
  const outlineSetting = useEditorSetting('outline')
  const showCounts = useEditorSetting('showCounts')
  const tab = useInspectorTab()
  const restoreRef = useRef<ApplyRestore | null>(null)
  const [infoPanel, setInfoPanel] = useState<HTMLDivElement | null>(null)
  const outlineRoom = useOutlineRoom(panesRef, mode, noteId)
  const outlineShown = outlineSetting && outlineRoom.fits
  const countsShown = Boolean(core && noteId && showCounts && mode !== 'preview')
  const [viewing, setViewing] = useState<ViewedImage | null>(null)
  const [held, setHeld] = useState<'quit' | 'close' | undefined>()
  // Read-only while the note is in the Trash or once it is purged (see nextLife).
  const [life, setLife] = useState<NoteLife>('live')
  const editing = useEditing()
  const readOnly = !editing || life !== 'live'
  useEffect(() => startLicence(), [])
  useSaveAtTrialEnd(editing, core)
  const showAlertMenu = useAlertMenu()
  const setImageSize = useCallback<SetImageSize>((source, size) => {
    editorRef.current?.setImageSize(source, size)
  }, [])
  const showImageMenu = useImageMenu(setImageSize)

  const { problems, noticeShown, setDismissed, quitGuard, closeGuard, onSaveProblems } =
    useSaveProblems(
      useCallback((_previous: readonly SaveProblem[], next: SaveProblem[]) => {
        if (next.length === 0) setHeld(undefined)
      }, []),
    )

  const reloadMeta = useCallback(async (c: Core, id: string) => {
    const seq = ++metaSeqRef.current
    const [nextBooks, nextTags, [summary]] = await Promise.all([
      c.listBooks(),
      c.listTags(),
      c.noteSummaries([id]),
    ])
    if (!aliveRef.current || seq !== metaSeqRef.current) return
    setBooks(nextBooks)
    setTags([...nextTags].sort((a, b) => compareNames(a.name, b.name, navigator.languages)))
    if (summary) setNoteSummary(summary)
    window.dispatchEvent(notesLoaded([id]))
  }, [])

  const takeIn = useCallback((change: TakenIn) => {
    if (change.kind === 'title') return setTitle(change.title)
    const editor = editorRef.current
    if (editor?.noteId === change.noteId) editor.takeState(change.update)
  }, [])

  useEffect(() => {
    aliveRef.current = true
    let alive = true
    let started: Core | undefined
    let stopRelay: (() => void) | undefined
    let stopLists: (() => void) | undefined
    let listsWrote: ReturnType<typeof coalesced> | undefined
    let listsReload: ReturnType<typeof coalesced> | undefined
    void (async () => {
      const id = await invoke<string>('note_window_note')
      const link = relayLink(noteWindowLabel(id))
      const lists = listsLink(noteWindowLabel(id))
      const wrote = coalesced(() => lists.send(), LISTS_WROTE_MS)
      const reload = coalesced(
        () => window.dispatchEvent(new CustomEvent(DB_CHANGED)),
        LISTS_RELOAD_MS,
      )
      listsWrote = wrote
      listsReload = reload
      listsWroteRef.current = wrote
      const showWrites = (writes: ReadonlyMap<string, number>) => {
        if (alive) setNoteSummary((now) => summaryAfterWrites(now, writes))
      }
      started = await startCore(onSaveProblems, showWrites, (code) => console.error(code), {
        lean: true,
        relayAll: true,
        onWrote: () => wrote(),
        onRelay: (message) => link.send(message),
        onTakenIn: takeIn,
      })
      const c = started
      if (!alive) return stopCore(c)
      const listening = link.listen((message) => {
        // A note trashed, purged or put back in another window: this one keeps its text and says why it is read-only.
        if (message.kind === 'gone' || message.kind === 'back') {
          setLife((was) => nextLife(was, message))
          if (message.kind === 'back') void reloadMeta(c, id).catch(() => {})
          return
        }
        void c
          .relayIn(message)
          .then(() => {
            if (message.kind === 'saved') {
              return c.mergeStored().then(() => reloadMeta(c, id))
            }
            return undefined
          })
          .catch((e: unknown) => {
            console.warn('W_NOTE_RELAY_IN_FAILED', message.noteId, errorCode(e))
          })
      })
      stopRelay = () => void listening.then((stop) => stop())
      const listsListening = lists.listen(reload)
      stopLists = () => void listsListening.then((stop) => stop())
      // Reading the note asks the other windows for what this one lacks (`want`): hear the answer.
      await listening
      const [name] = await Promise.all([c.title(id), reloadMeta(c, id)])
      if (!alive) return stopCore(c)
      setTitle(name)
      setNoteId(id)
      coreRef.current = c
      setCore(() => c)
    })().catch((e: unknown) => {
      if (!alive) {
        if (started) stopCore(started)
        return
      }
      const code = errorCode(e)
      console.warn('W_NOTE_WINDOW_OPEN_FAILED', code)
      setFailure(code)
    })
    return () => {
      alive = false
      aliveRef.current = false
      listsWroteRef.current = undefined
      listsWrote?.cancel()
      listsReload?.cancel()
      stopRelay?.()
      stopLists?.()
    }
  }, [onSaveProblems, takeIn, reloadMeta])

  useEffect(() => nameWindow(title || t('note.untitled')), [title])

  useSaveOnHide(core)

  // Heard from the start: Rust waits for an answer to every close and quit, and a window still
  // opening, or one that could not open its note, has nothing of its own to save.
  useEffect(() => {
    const answer = (asked: Asked) =>
      void answerAsked(
        asked,
        asked === 'close' ? closeGuard : quitGuard,
        coreRef.current?.flush({ versions: true }),
        () => {
          setHeld(asked === 'close' ? 'close' : 'quit')
          setDismissed(false)
        },
        async () => {
          listsWroteRef.current?.flush()
        },
      )
    return listenAsked(
      () => answer('close'),
      (round) => answer({ round }),
    )
  }, [quitGuard, closeGuard, setDismissed])

  useEffect(
    () =>
      onRestoreElsewhere(async () => {
        const ready = coreRef.current
        if (!ready) return
        try {
          await saveEdits(ready)
        } finally {
          stopCore(ready)
        }
      }),
    [],
  )

  // Another process or window wrote: merge stored state, update title/metadata pills and editor.
  useExternalChanges(
    core && noteId
      ? async () => {
          const { retitled } = await core.mergeStored()
          const outsideTitle = retitled.find((note) => note.id === noteId)?.title
          if (outsideTitle !== undefined) setTitle(outsideTitle)
          await reloadMeta(core, noteId)
        }
      : undefined,
  )

  const tree = useMemo(() => buildBookTree(books), [books])
  const isTemplate = noteSummary?.bookId === TEMPLATES_BOOK_ID
  const noteTags = useMemo(
    () => (noteSummary?.tagIds ?? []).flatMap((id) => tags.find((tag) => tag.id === id) ?? []),
    [noteSummary?.tagIds, tags],
  )
  const previewFields =
    noteSummary && !isTemplate
      ? {
          title,
          status: noteSummary.status,
          tags: noteTags.map((tag) => tag.name),
          tagColors: tags.flatMap(({ name, color }) => (color ? [{ name, color }] : [])),
          canApply: !readOnly,
        }
      : undefined

  const rename = (next: string) => {
    if (!core || !noteId || readOnly) return
    const clean = clipTitle(next)
    setTitle(clean)
    void core.setTitle(noteId, clean)
  }

  const runMetaChange = async (work: (c: Core) => Promise<unknown>) => {
    if (!core || !noteId || readOnly) return
    try {
      await saveEdits(core)
      await work(core).catch((e: unknown) => {
        console.warn('W_NOTE_WINDOW_META_FAILED', noteId, errorCode(e))
      })
      await saveEdits(core)
      listsWroteRef.current?.flush()
      await reloadMeta(core, noteId)
    } catch (e: unknown) {
      console.warn('W_NOTE_WINDOW_META_FAILED', noteId, errorCode(e))
    }
  }

  const setNoteDates = async (id: string, dates: { createdAt?: number; updatedAt?: number }) => {
    if (!core || !noteId || readOnly) return
    await saveEdits(core)
    await core.setNoteDates(id, dates)
    await saveEdits(core)
    listsWroteRef.current?.flush()
    await reloadMeta(core, noteId)
  }

  if ((readOnly || isTemplate) && quickTagOpen) setQuickTagOpen(false)

  const find = useFind({
    mode,
    noteOpen: core !== undefined && noteId !== undefined,
    editing: !readOnly,
    editor: editorFind,
    preview: previewFind,
  })
  const statusCommands: CommandHandlers =
    core && noteId && !readOnly && !isTemplate
      ? Object.fromEntries(
          NOTE_STATUSES.map((status) => [
            STATUS_COMMANDS[status],
            { run: () => void runMetaChange((c) => c.setStatus(noteId, status)) },
          ]),
        )
      : {}
  const windowCommands: CommandHandlers = {
    ...find.commands,
    ...statusCommands,
    ...(core && noteId && !isTemplate ? { 'view.noteInfo': { run: requestNoteInfo } } : {}),
    ...(core && noteId && !readOnly && !isTemplate
      ? { 'note.quickTag': { run: () => setQuickTagOpen(true) } }
      : {}),
  }
  useWindowCommands(windowCommands)

  const applyFrontMatter = (change: FrontMatterChange) => {
    if (!noteId || readOnly) return
    if (change.field === 'title') return rename(change.value)
    if (change.field === 'status')
      return void runMetaChange((c) => c.setStatus(noteId, change.value))
    const { add, remove } = tagChanges(noteTags, change.value)
    void runMetaChange(async (c) => {
      for (const name of add) await c.addTag(noteId, name)
      for (const tagId of remove) await c.removeTag(noteId, tagId)
    })
  }

  const openNote = (id: string) =>
    void invoke('note_window_open', { id }).catch((e: unknown) => {
      console.warn('W_NOTE_WINDOW_OPEN_FAILED', id, errorCode(e))
    })

  const findLinkTargets = async (query: string) => {
    if (!core) return []
    const found = query
      ? (await core.search(query, undefined, { flush: false, shortInTitles: true })).found
      : await core.list(MAX_LINK_NOTES + 1)
    return found.filter((n) => n.id !== noteId)
  }

  const createLinkedNote = linkedNoteCreate(
    () => (noteId ? core : null),
    async (c) => (noteId ? (await c.read(noteId)).bookId : null),
  )

  const discardLinkedNote = linkedNoteDiscard(() => core)

  const quickTagKey = commandKeys('note.quickTag')[0]
  const quickTagShortcut = quickTagKey ? shortcutLabel(quickTagKey) : undefined

  if (failure) {
    return (
      <div className="window note-window" data-ready>
        <p role="alert" className="note-window-failure">
          {failureText('noteWindow.unavailable', failure)}
        </p>
      </div>
    )
  }

  return (
    <div className="window note-window" data-ready={core ? '' : undefined}>
      <main className="content" data-devot-part="editor">
        <div className="toolbar editor-toolbar" data-devot-part="toolbar">
          {core ? <ModeControl mode={mode} onChange={setMode} /> : null}
        </div>
        {core && noteId ? (
          <>
            <input
              className="title"
              aria-label={t('note.titleLabel')}
              placeholder={displayTitle('', headline)}
              value={title}
              readOnly={readOnly}
              onChange={(e) => rename(e.target.value)}
              onKeyDown={(e) => {
                // Return goes on to the tags (or body when locked/template); Down Arrow goes to the body.
                if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
                if (isImeKey(e.nativeEvent)) return
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  return void editorRef.current?.focusStart()
                }
                if (e.key !== 'Enter') return
                e.preventDefault()
                if (!readOnly && !isTemplate && tagInputRef.current) {
                  return tagInputRef.current.focus()
                }
                editorRef.current?.focusStart()
              }}
            />
            {isTemplate ? (
              <p className="note-meta template-hint">{t('templates.editorHint')}</p>
            ) : (
              <div className="note-meta">
                <div className="note-meta-fields" inert={readOnly}>
                  <BookPicker
                    tree={tree}
                    value={noteSummary?.bookId ?? null}
                    onChange={(bookId) => void runMetaChange((c) => c.setBook(noteId, bookId))}
                  />
                  <StatusPicker
                    value={noteSummary?.status ?? 'none'}
                    onChange={(status) => void runMetaChange((c) => c.setStatus(noteId, status))}
                  />
                  <TagEditor
                    inputRef={tagInputRef}
                    tags={tags}
                    value={noteSummary?.tagIds ?? []}
                    onAdd={(name) => void runMetaChange((c) => c.addTag(noteId, name))}
                    onPut={(tagId) =>
                      void runMetaChange((c) => c.batch([noteId], { kind: 'putTag', tagId }))
                    }
                    onRemove={(tagId) => void runMetaChange((c) => c.removeTag(noteId, tagId))}
                    quick={{
                      open: !readOnly && quickTagOpen,
                      onOpen: () => setQuickTagOpen(true),
                      onClose: () => setQuickTagOpen(false),
                      counts: EMPTY_TAG_COUNTS,
                      shortcut: quickTagShortcut,
                      onCreate: async (name, color) => {
                        let created: string | undefined
                        await runMetaChange(async (c) => {
                          created = await c.addTag(noteId, name)
                          if (color) await c.setTagColor(created, color)
                        })
                        return created
                      },
                    }}
                  />
                </div>
                {noteSummary ? (
                  <LiveNoteInfoSummary
                    key={noteId}
                    core={core}
                    text={openText}
                    info={{
                      noteId: noteSummary.id,
                      createdAt: noteSummary.createdAt,
                      updatedAt: noteSummary.updatedAt,
                    }}
                    note={previewFields}
                    inspectorPanel={infoPanel}
                    editor={readOnly ? undefined : editorRef}
                    onShowInspectorInfo={outlineShown ? () => tab.toggleInfo(noteId) : undefined}
                    onOpenNote={openNote}
                    onSetDates={readOnly ? undefined : setNoteDates}
                    onApplyFrontMatter={readOnly ? undefined : applyFrontMatter}
                    canLinkMentions={!readOnly}
                  />
                ) : null}
              </div>
            )}
            {find.bar}
            <div
              className={`panes panes-${mode}`}
              ref={panesRef}
              data-outline={outlineShown || undefined}
            >
              <NoteEditor
                core={core}
                noteId={noteId}
                autoFocus
                hidden={mode === 'preview'}
                write={mode === 'write'}
                onText={openText.changed}
                onFind={setEditorFind}
                onCounts={countsShown ? editorCounts.set : undefined}
                onVimMode={editorCounts.setVimMode}
                links={{
                  find: findLinkTargets,
                  create: createLinkedNote,
                  discard: discardLinkedNote,
                  linked: () => {},
                }}
                showAlertMenu={showAlertMenu}
                restoreRef={restoreRef}
                handleRef={editorRef}
                onCaretLine={caretLine.set}
                onOpenImage={setViewing}
                showImageMenu={showImageMenu}
                onOpenNote={openNote}
                readOnly={readOnly}
              />
              {editorOnly(mode) ? null : (
                <LivePreview
                  core={core}
                  text={openText}
                  noteId={noteId}
                  frontMatterInInfo={!isTemplate}
                  onFind={setPreviewFind}
                  onOpenNote={openNote}
                  onOpenImage={setViewing}
                  onImageMenu={showImageMenu}
                  onScrollPane={setPreviewPane}
                  onToggleTask={
                    readOnly ? undefined : (at) => void editorRef.current?.toggleTask(at)
                  }
                  blocksEditable={!readOnly}
                />
              )}
              {outlineShown ? (
                <Inspector
                  noteId={noteId}
                  room={outlineRoom}
                  tab={tab}
                  infoRef={setInfoPanel}
                  info={
                    isTemplate &&
                    noteSummary && (
                      <LiveNoteInfoSummary
                        inline
                        core={core}
                        text={openText}
                        info={{
                          noteId: noteSummary.id,
                          createdAt: noteSummary.createdAt,
                          updatedAt: noteSummary.updatedAt,
                        }}
                        editor={readOnly ? undefined : editorRef}
                        onOpenNote={openNote}
                      />
                    )
                  }
                  history={
                    <LazyHistory
                      key={noteId}
                      inline
                      shown={tab.active === 'history'}
                      core={core}
                      noteId={noteId}
                      title={title}
                      books={books}
                      updatedAt={noteSummary?.updatedAt}
                      readOnly={readOnly}
                      onRestore={(update) => {
                        if (editorRef.current?.noteId === noteId) restoreRef.current?.(update)
                      }}
                    />
                  }
                  outline={{
                    text: openText,
                    caret: caretLine,
                    mode,
                    previewPane,
                    folded,
                    onToggle: (key) =>
                      setFolded((now) => {
                        const next = new Set(now)
                        if (!next.delete(key)) next.add(key)
                        return next
                      }),
                    onJump: (line) => {
                      editorRef.current?.goToLine(line, 'start', false)
                      if (!editorOnly(mode) && previewPane) scrollPreviewTo(previewPane, line)
                    },
                    onLeave: () => editorRef.current?.focus(),
                  }}
                />
              ) : null}
            </div>
            {countsShown ? <LiveCountsFooter store={editorCounts} /> : null}
          </>
        ) : null}
      </main>
      <Notices>
        <ActivationBar />
        <TrialEndedBar />
        {life !== 'live' ? (
          <div role="alert" className="notice" data-devot-part="notice">
            <span className="notice-text">
              {t(life === 'purged' ? 'noteWindow.purged' : 'noteWindow.trashed')}
            </span>
          </div>
        ) : null}
        <ImageActionNotice />
        {noticeShown ? (
          <SaveNotice
            problems={problems}
            quitHeld={held === 'quit'}
            closeHeld={held === 'close'}
            onRetry={() => void (core && saveEdits(core))}
            onDismiss={() => setDismissed(true)}
          />
        ) : null}
      </Notices>
      {viewing ? <ImageViewer image={viewing} onClose={() => setViewing(null)} /> : null}
    </div>
  )
}
