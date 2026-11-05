// A note in a window of its own (src-tauri/src/note_window.rs): its title, its editor and the preview
// modes, on a core of its own. What this window and the others change in the note reaches each at
// once (noteRelay.ts), and each saves its own changes. Closing the window, and quitting, save first.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SaveProblem, TakenIn } from '../../../core'
import { errorCode } from '../../../core/errors'
import { clipTitle } from '../../../core/noteLimits'
import { onRestoreElsewhere } from '../backups'
import { startCore, stopCore, type Core } from '../core-client'
import { useAlertMenu } from '../editor/alertMenu'
import { useExternalChanges } from '../externalChanges'
import { t, format } from '../i18n'
import { useImageMenu, type SetImageSize } from '../imageMenu'
import { ImageActionNotice } from '../ImageNotice'
import { ImageViewer, type ViewedImage } from '../ImageViewer'
import { isImeKey } from '../ime'
import { invoke } from '../ipc'
import { startLicence, useEditing } from '../licence'
import { MAX_LINK_NOTES } from '../linkCompletion'
import { currentDefaultMode } from '../lastState'
import { ModeControl, editorOnly, type Mode } from '../ModeControl'
import type { EditorHandle } from '../editor/handle'
import { NoteEditor } from '../NoteEditor'
import { noteWindowLabel, relayLink } from '../noteRelay'
import { Notices } from '../Notices'
import { LivePreview } from '../preview/Preview'
import { SaveNotice } from '../SaveNotice'
import {
  CLOSE_EVENT,
  FLUSH_EVENT,
  answerAsked,
  saveEdits,
  useSaveAtTrialEnd,
  useSaveOnHide,
  useSaveProblems,
} from '../saveGuards'
import { textStore } from '../textStore'
import { useEditorSetting } from '../editorSettings'
import { OutlinePanel, lineStore } from '../outline/OutlinePanel'
import { scrollPreviewTo } from '../outline/room'
import { useOutlineRoom } from '../outline/useOutlineRoom'
import type { ScrollPane } from '../preview/scrollSync'
import { ActivationBar, TrialEndedBar } from '../TrialNotices'

/** Hears what Rust asks of this window: the global quit, and the close of this window alone. */
function listenAsked(onClose: () => void, onQuit: () => void): () => void {
  window.addEventListener(CLOSE_EVENT, onClose)
  window.addEventListener(FLUSH_EVENT, onQuit)
  const stops: (() => void)[] = []
  let stopped = false
  if (!DEVOT_UI_TEST) {
    void Promise.all([import('@tauri-apps/api/event'), import('@tauri-apps/api/webviewWindow')])
      .then(async ([{ listen }, { getCurrentWebviewWindow }]) => {
        const own = await Promise.all([
          getCurrentWebviewWindow().listen('devot://note-window-close', onClose),
          listen('devot://flush-before-exit', onQuit),
        ])
        if (stopped) own.forEach((stop) => stop())
        else stops.push(...own)
      })
      .catch(() => console.warn('W_NOTE_WINDOW_LISTEN_FAILED'))
  }
  return () => {
    stopped = true
    window.removeEventListener(CLOSE_EVENT, onClose)
    window.removeEventListener(FLUSH_EVENT, onQuit)
    stops.forEach((stop) => stop())
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
  const [core, setCore] = useState<Core>()
  const coreRef = useRef<Core | undefined>(undefined)
  const [noteId, setNoteId] = useState<string>()
  const [failure, setFailure] = useState<string>()
  const [title, setTitle] = useState('')
  const [mode, setMode] = useState<Mode>(currentDefaultMode)
  const [openText] = useState(() => textStore())
  const editorRef = useRef<EditorHandle | null>(null)
  const panesRef = useRef<HTMLDivElement>(null)
  const [caretLine] = useState(() => lineStore())
  const [previewPane, setPreviewPane] = useState<ScrollPane | null>(null)
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set())
  const outlineSetting = useEditorSetting('outline')
  const outlineRoom = useOutlineRoom(panesRef, mode, noteId)
  const outlineShown = outlineSetting && outlineRoom
  const [viewing, setViewing] = useState<ViewedImage | null>(null)
  const [held, setHeld] = useState<'quit' | 'close' | undefined>()
  // The note went to the Trash, or was purged, while this window showed it: read-only from then on.
  const [gone, setGone] = useState<'trashed' | 'purged'>()
  const editing = useEditing()
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

  const takeIn = useCallback((change: TakenIn) => {
    if (change.kind === 'title') return setTitle(change.title)
    const editor = editorRef.current
    if (editor?.noteId === change.noteId) editor.takeState(change.update)
  }, [])

  useEffect(() => {
    let alive = true
    let started: Core | undefined
    let stopListening: (() => void) | undefined
    void (async () => {
      const id = await invoke<string>('note_window_note')
      const link = relayLink(noteWindowLabel(id))
      started = await startCore(onSaveProblems, undefined, (code) => console.error(code), {
        lean: true,
        onRelay: (message) => link.send(message),
        onTakenIn: takeIn,
      })
      const c = started
      if (!alive) return stopCore(c)
      const listening = link.listen((message) => {
        // A note trashed or purged in another window: this one keeps its text, read-only, and says why.
        if (message.kind === 'gone') {
          setGone(message.purged ? 'purged' : 'trashed')
          return
        }
        void c.relayIn(message).catch((e: unknown) => {
          console.warn('W_NOTE_RELAY_IN_FAILED', message.noteId, errorCode(e))
        })
      })
      stopListening = () => void listening.then((stop) => stop())
      // Reading the note asks the other windows for what this one lacks (`want`): hear the answer.
      await listening
      const name = await c.title(id)
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
      stopListening?.()
    }
  }, [onSaveProblems, takeIn])

  useEffect(() => nameWindow(title || t('note.untitled')), [title])

  useSaveOnHide(core)

  // Heard from the start: Rust waits for an answer to every close and quit, and a window still
  // opening, or one that could not open its note, has nothing of its own to save.
  useEffect(() => {
    const answer = (asked: 'quit' | 'close') =>
      void answerAsked(
        asked,
        asked === 'quit' ? quitGuard : closeGuard,
        coreRef.current?.flush({ versions: true }),
        () => {
          setHeld(asked)
          setDismissed(false)
        },
      )
    return listenAsked(
      () => answer('close'),
      () => answer('quit'),
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

  // Another process wrote: the note takes it in, and the editor what changed (takeIn).
  useExternalChanges(
    core
      ? async () => {
          await core.mergeStored()
        }
      : undefined,
  )

  const rename = (next: string) => {
    if (!core || !noteId) return
    const clean = clipTitle(next)
    setTitle(clean)
    void core.setTitle(noteId, clean)
  }

  const openNote = (id: string) =>
    void invoke('note_window_open', { id }).catch((e: unknown) => {
      console.warn('W_NOTE_WINDOW_OPEN_FAILED', id, errorCode(e))
    })

  const findLinkTargets = async (query: string) => {
    if (!core) return []
    const found = query
      ? (await core.search(query, undefined, { flush: false })).found
      : await core.list(MAX_LINK_NOTES + 1)
    return found.filter((n) => n.id !== noteId)
  }

  const createLinkedNote = async (linkTitle: string) => {
    if (!core || !noteId) throw new Error('E_CORE_NOT_READY')
    return core.create(linkTitle, (await core.read(noteId)).bookId)
  }

  const discardLinkedNote = async (id: string) => {
    if (!core) return
    await core
      .trash(id)
      .then(() => core.purge(id))
      .catch(() => console.warn('W_NOTE_DROP_FAILED', id))
  }

  if (failure) {
    return (
      <div className="window note-window" data-ready>
        <p role="alert" className="note-window-failure">
          {format(t('noteWindow.unavailable'), { code: failure })}
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
              placeholder={t('note.untitled')}
              value={title}
              readOnly={!editing || gone !== undefined}
              onChange={(e) => rename(e.target.value)}
              onKeyDown={(e) => {
                // Return and Down Arrow go on to the body, as in the main window.
                if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
                if (isImeKey(e.nativeEvent)) return
                if (e.key !== 'Enter' && e.key !== 'ArrowDown') return
                e.preventDefault()
                editorRef.current?.focusStart()
              }}
            />
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
                links={{
                  find: findLinkTargets,
                  create: createLinkedNote,
                  discard: discardLinkedNote,
                  linked: () => {},
                }}
                showAlertMenu={showAlertMenu}
                handleRef={editorRef}
                onCaretLine={caretLine.set}
                onOpenImage={setViewing}
                showImageMenu={showImageMenu}
                onOpenNote={openNote}
                readOnly={!editing || gone !== undefined}
              />
              {editorOnly(mode) ? null : (
                <LivePreview
                  core={core}
                  text={openText}
                  onOpenNote={openNote}
                  onOpenImage={setViewing}
                  onImageMenu={showImageMenu}
                  onScrollPane={setPreviewPane}
                  onToggleTask={
                    editing ? (at) => void editorRef.current?.toggleTask(at) : undefined
                  }
                />
              )}
              {outlineShown ? (
                <OutlinePanel
                  text={openText}
                  caret={caretLine}
                  mode={mode}
                  previewPane={previewPane}
                  folded={folded}
                  onToggle={(key) =>
                    setFolded((now) => {
                      const next = new Set(now)
                      if (!next.delete(key)) next.add(key)
                      return next
                    })
                  }
                  onJump={(line) => {
                    editorRef.current?.goToLine(line, 'start', false)
                    if (!editorOnly(mode) && previewPane) scrollPreviewTo(previewPane, line)
                  }}
                  onLeave={() => editorRef.current?.focus()}
                />
              ) : null}
            </div>
          </>
        ) : null}
      </main>
      <Notices>
        <ActivationBar />
        <TrialEndedBar />
        {gone ? (
          <div role="alert" className="notice" data-devot-part="notice">
            <span className="notice-text">
              {t(gone === 'purged' ? 'noteWindow.purged' : 'noteWindow.trashed')}
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
