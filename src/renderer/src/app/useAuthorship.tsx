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
import { errorCode } from '../../../core/errors'
import { ConfirmDialog } from '../ConfirmDialog'
import type { Core } from '../core-client'
import type { EditorHandle } from '../editor/handle'
import { t } from '../i18n'
import type { Mode } from '../ModeControl'
import type { ApplyRestore } from '../NoteEditor'
import { saveEdits } from '../saveGuards'
import { followReviewSwitch, type ReviewSwitch } from './reviewSwitch'

type AgentWrites = ReturnType<typeof useAgentWrites>

/**
 * Restore after an Undo of several writes: offered while the note is unchanged since, and restoring until the
 * core answers; `token` is the core's for that Undo.
 */
type RestoreOffer =
  | { kind: 'none' }
  | {
      kind: 'offered' | 'restoring'
      noteId: string
      token: string
      writes: readonly string[]
      writeId: string
    }

const NO_OFFER: RestoreOffer = { kind: 'none' }

/** The agent writes the open note's notice shows, marked seen once it no longer shows them. */
export function useShownWrites(core: Core | undefined, agentWrites: AgentWrites) {
  const shownWrites = useRef<{ noteId: string; ids: Set<string> } | undefined>(undefined)
  // Marking runs in call order: a later note's reload must not overtake an
  // earlier note's write, or its older read can bring a dismissed notice back.
  const seenQueue = useRef<Promise<unknown>>(Promise.resolve())
  const reloadAgentWrites = agentWrites.reload
  const markShownSeen = useCallback(
    (options?: { reload?: boolean }) => {
      const shown = shownWrites.current
      shownWrites.current = undefined
      if (!core) return Promise.resolve()
      const next = seenQueue.current.then(async () => {
        await markSeen(core, reloadAgentWrites, shown, options)
      })
      seenQueue.current = next
      return next
    },
    [core, reloadAgentWrites],
  )
  /** Stops the notice's set naming `writeId`, which was kept or undone by itself. */
  const forgetShownWrite = useCallback((noteId: string, writeId: string) => {
    const shown = shownWrites.current
    if (shown?.noteId !== noteId) return
    shown.ids.delete(writeId)
    if (shown.ids.size === 0) shownWrites.current = undefined
  }, [])
  /** Marks one kept write seen, resolving with the failure's code or undefined once saved. */
  const markWriteSeen = useCallback(
    (noteId: string, writeId: string): Promise<string | undefined> => {
      if (!core) return Promise.resolve('E_CORE_NOT_READY')
      const next = seenQueue.current.then(async () => {
        const failed = await markSeen(core, reloadAgentWrites, {
          noteId,
          ids: new Set([writeId]),
        })
        if (failed === undefined) forgetShownWrite(noteId, writeId)
        return failed
      })
      seenQueue.current = next
      return next
    },
    [core, reloadAgentWrites, forgetShownWrite],
  )
  return {
    shownWrites,
    markShownSeen,
    markWriteSeen,
    forgetShownWrite,
    reloadAgentWrites,
  }
}

export function useAuthorshipNotice({
  core,
  editing,
  selected,
  inTrash,
  multiIds,
  selectedIsTemplate,
  mode,
  setMode,
  editorMode,
  agentWrites,
  shown: { shownWrites, markShownSeen, markWriteSeen, forgetShownWrite, reloadAgentWrites },
  editorRef,
  editorHandle,
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
  setMode: Dispatch<SetStateAction<Mode>>
  editorMode: RefObject<Mode>
  agentWrites: AgentWrites
  shown: ReturnType<typeof useShownWrites>
  editorRef: RefObject<EditorHandle | null>
  /** `editorRef`'s handle as state: a new replica for the same note replaces it. */
  editorHandle: EditorHandle | null
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
  const reviewSwitch = useRef<ReviewSwitch | undefined>(undefined)
  useEffect(() => {
    if (shownWrites.current && shownWrites.current.noteId !== noticeNote) markShownSeen()
    if (noticeNote === undefined || openUnseen.length === 0) return
    shownWrites.current ??= { noteId: noticeNote, ids: new Set() }
    for (const row of openUnseen) shownWrites.current.ids.add(row.writeId)
  }, [noticeNote, openUnseen, markShownSeen, shownWrites])
  const [offer, setOffer] = useState<RestoreOffer>(NO_OFFER)
  const offerHere = offer.kind !== 'none' && offer.noteId === noticeNote ? offer : undefined
  if (offer.kind !== 'none' && (offer.noteId !== noticeNote || mode === 'preview'))
    setOffer(NO_OFFER)
  const watching = offer.kind === 'offered' ? offer.token : undefined
  useEffect(() => {
    if (watching === undefined || !editorHandle) return
    // Any change since the Undo ends the offer; the review no longer puts Preview back over the owner's typing.
    return editorHandle.changed(() => {
      reviewSwitch.current = undefined
      setOffer((now) => (now.kind === 'offered' && now.token === watching ? NO_OFFER : now))
    })
  }, [watching, editorHandle])
  useEffect(() => {
    // The review stays open to offer Restore after its last change, so Preview waits for it.
    if (offerHere) return
    const { next, toPreview } = followReviewSwitch(reviewSwitch.current, {
      noteId: noticeNote,
      unseen: openUnseen.length,
      mode,
    })
    reviewSwitch.current = next
    if (toPreview) setMode('preview')
  }, [noticeNote, openUnseen.length, mode, setMode, offerHere])
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
  const undoSingleWrite = async (
    noteId: string,
    writeId: string,
  ): Promise<boolean | 'restorable'> => {
    if (!core || !editing) return false
    // The core forgets its Restore at every Undo, so the notice does too.
    setOffer(NO_OFFER)
    try {
      const undone = await core.undoAgentWrite(noteId, writeId)
      forgetShownWrite(noteId, writeId)
      const here = editorRef.current?.noteId === noteId
      if (here) restoreRef.current?.(undone.update)
      if (undone.dropped > 0) setUndoDropped(true)
      const restorable = here && undone.restore !== undefined
      if (undone.restore && restorable) {
        setOffer({
          kind: 'offered',
          noteId,
          token: undone.restore.token,
          writes: undone.restore.writes,
          writeId,
        })
      }
      await saveEdits(core)
      reloadAgentWrites()
      return restorable ? 'restorable' : true
    } catch (e) {
      console.warn('W_AUTHORSHIP_UNDO_FAILED', noteId, errorCode(e))
      setChangeNotice(errorCode(e))
      return false
    }
  }
  /** Restore: puts back the writes the offered Undo took out, unseen; false when the core refused or failed. */
  const restoreUndone = async (): Promise<boolean> => {
    const asked = offer
    if (!core || !editing || asked.kind !== 'offered') return false
    setOffer({ ...asked, kind: 'restoring' })
    try {
      const restored = await core.restoreAgentWrites(asked.noteId, asked.token)
      if (editorRef.current?.noteId === asked.noteId) restoreRef.current?.(restored.update)
      await saveEdits(core)
      // The notice reads the writes' unseen rows as soon as Restore answers.
      await reloadAgentWrites()
      return true
    } catch (e) {
      console.warn('W_AUTHORSHIP_RESTORE_FAILED', asked.noteId, errorCode(e))
      setChangeNotice(errorCode(e))
      return false
    } finally {
      setOffer((now) => (now.kind !== 'none' && now.token === asked.token ? NO_OFFER : now))
    }
  }
  const keepWrite = async (noteId: string, writeId: string): Promise<boolean> => {
    const failed = await markWriteSeen(noteId, writeId)
    if (failed !== undefined) setChangeNotice(failed)
    return failed === undefined
  }
  const startReviewFromNotice = (noteId: string) => {
    if (mode !== 'preview') return
    const next = editorMode.current
    reviewSwitch.current = { noteId, switchedTo: next, shown: false }
    setMode(next)
  }
  const endReviewMode = (noteId: string) => {
    setOffer(NO_OFFER)
    const switched = reviewSwitch.current
    reviewSwitch.current = undefined
    if (switched && switched.noteId === noteId && mode === switched.switchedTo) {
      setMode('preview')
      return
    }
    if (mode !== 'preview') editorRef.current?.focus()
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
    noticeNote !== undefined && (openUnseen.length > 0 || offerHere) ? (
      <AuthorshipNotice
        key={noticeNote}
        unseen={openUnseen}
        written={agentWrites.view.byNote.get(noticeNote) ?? []}
        editor={editorRef}
        canReview={mode !== 'preview'}
        editing={editing}
        onStartReview={() => startReviewFromNotice(noticeNote)}
        onEndReview={() => endReviewMode(noticeNote)}
        onKeepWrite={(writeId) => keepWrite(noticeNote, writeId)}
        onUndoWrite={(writeId) => undoSingleWrite(noticeNote, writeId)}
        restore={offerHere}
        onRestore={restoreUndone}
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
