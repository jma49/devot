import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react'
import { markSeen, unseenOf, type useAgentWrites } from '../agentWrites'
import { AuthorshipNotice } from '../AuthorshipNotice'
import { writerNames, type WriterRef } from '../authorshipLabels'
import { errorCode } from '../backups'
import { ConfirmDialog } from '../ConfirmDialog'
import type { Core } from '../core-client'
import type { EditorHandle } from '../editor/handle'
import { t } from '../i18n'
import type { Mode } from '../ModeControl'
import type { ApplyRestore } from '../NoteEditor'
import { saveEdits } from '../saveGuards'

type AgentWrites = ReturnType<typeof useAgentWrites>

/** The agent writes the open note's notice shows, marked seen once it no longer shows them. */
export function useShownWrites(core: Core | undefined, agentWrites: AgentWrites) {
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
  return { shownWrites, markShownSeen, reloadAgentWrites }
}

export function useAuthorshipNotice({
  core,
  editing,
  selected,
  inTrash,
  multiIds,
  selectedIsTemplate,
  mode,
  agentWrites,
  shown: { shownWrites, markShownSeen, reloadAgentWrites },
  editorRef,
  restoreRef,
  setChangeNotice,
}: {
  core: Core | undefined
  editing: boolean
  selected: string | undefined
  inTrash: boolean
  multiIds: readonly string[] | undefined
  selectedIsTemplate: boolean
  mode: Mode
  agentWrites: AgentWrites
  shown: ReturnType<typeof useShownWrites>
  editorRef: RefObject<EditorHandle | null>
  restoreRef: RefObject<ApplyRestore | null>
  setChangeNotice: Dispatch<SetStateAction<string | undefined>>
}) {
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
  }, [noticeNote, openUnseen, markShownSeen, shownWrites])
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
      const undone = await core.undoAgentWrites(noteId, writerNames(writer))
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
  const undoDroppedNotice = undoDropped ? (
    <div role="status" className="notice" data-devot-part="notice">
      <span className="notice-text">{t('authorship.undoDropped')}</span>
      <button type="button" className="button" onClick={() => setUndoDropped(false)}>
        {t('notice.dismiss')}
      </button>
    </div>
  ) : null
  const clearDialog =
    clearing !== undefined ? (
      <ConfirmDialog
        destructive
        message={t('authorship.clearMessage')}
        detail={t('authorship.clearDetail')}
        confirm={t('authorship.clear')}
        onConfirm={() => void clearNoteAuthorship(clearing)}
        onCancel={() => setClearing(undefined)}
      />
    ) : null
  return { authorshipNotice, undoDroppedNotice, clearDialog, setClearing }
}
