import { useMemo, useRef, useState } from 'react'
import type { NoteStatus, NoteSummary, TagRecord } from '../../core'
import { TEMPLATES_BOOK_ID, type BookNode } from '../../core/books'
import { errorCode } from './backups'
import { writeClipboardText } from './clipboard'
import type { ExportFailure } from './ExportNotice'
import { noteCount } from './format'
import { currentLocale, format, t } from './i18n'
import { MoveNoteDialog } from './MoveNoteDialog'
import {
  EXPORT_ACTIONS,
  noteClipboardText,
  noteLinks,
  useNoteMenu,
  type ExportAction,
  type NoteAction,
  type NoteMenuAction,
  type NoteMenuTarget,
} from './noteMenu'
import { TagPickDialog } from './TagPickDialog'

/**
 * The note actions of the context menu, the list shortcuts, the palette and
 * the selection summary: `run(action, id)` for a shortcut (on the selection
 * when `id` is part of it), `runOn(action, ids)` on given notes, `menu(id)`
 * for a right-click, and the notebook and tag pickers to render while one is
 * open. Changes to notes go through `deps`, one call for all of them.
 */
export function useNoteActions(deps: {
  notes: NoteSummary[]
  tree: BookNode[]
  tags: readonly TagRecord[]
  /** Several notes selected in the list, in its order; undefined for one. */
  selection: readonly string[] | undefined
  duplicate: (id: string) => Promise<void>
  history: (id: string) => Promise<void>
  move: (ids: readonly string[], bookId: string | null) => Promise<void>
  setPinned: (ids: readonly string[], pinned: boolean) => Promise<void>
  setStatus: (ids: readonly string[], status: NoteStatus) => Promise<void>
  /** Puts the tag of a name typed (made when missing) on the notes. */
  addTag: (ids: readonly string[], name: string) => Promise<void>
  /** Puts a tag picked from the list on the notes, by its ID. */
  putTag: (ids: readonly string[], tagId: string) => Promise<void>
  removeTag: (ids: readonly string[], tagId: string) => Promise<void>
  trash: (ids: readonly string[]) => Promise<void>
  /** Exports or prints a note (exporter.ts); one note at a time. */
  exportNote: (action: ExportAction, id: string) => Promise<void>
  /** Shows that a copy did not complete, with its code (a notice). */
  copyFailed: (failure: ExportFailure, code: string) => void
}) {
  const [moving, setMoving] = useState<readonly string[]>()
  const [tagging, setTagging] = useState<{ mode: 'add' | 'remove'; ids: readonly string[] }>()
  const byId = useMemo(() => new Map(deps.notes.map((n) => [n.id, n])), [deps.notes])
  const listed = (ids: readonly string[]) => ids.flatMap((id) => byId.get(id) ?? [])
  // Pin states asked for but not yet in `notes`, so a quick second P unpins.
  const pinning = useRef(new Map<string, boolean>())
  const pinnedNow = (n: NoteSummary) => pinning.current.get(n.id) ?? n.pinned

  /** The notes an action on `id` acts on: the selection when `id` is in it. */
  const idsFor = (id: string): readonly string[] =>
    deps.selection?.includes(id) ? deps.selection : [id]

  /** Puts `text` on the clipboard; a failure is logged by its code and shown. */
  const copy = (text: string, failure: ExportFailure) =>
    writeClipboardText(text).catch((error: unknown) => {
      const code = errorCode(error)
      console.warn('W_NOTE_COPY_FAILED', code)
      deps.copyFailed(failure, code)
    })

  /** Whether the batch tag actions apply: several notes, none a template. */
  const taggable = (notes: readonly NoteSummary[]) =>
    notes.length > 1 && notes.every((n) => n.bookId !== TEMPLATES_BOOK_ID)

  /** Runs an action on these notes; what it returns settles once it is done. */
  const runOn = (action: NoteMenuAction, ids: readonly string[]): void | Promise<unknown> => {
    const notes = listed(ids)
    const first = notes[0]
    if (!first) return
    const many = notes.length > 1
    const noteIds = notes.map((n) => n.id)
    if (action.startsWith('status:')) {
      return deps.setStatus(noteIds, action.slice('status:'.length) as NoteStatus)
    }
    switch (action as Exclude<NoteMenuAction, `status:${string}`>) {
      case 'move':
        return setMoving(noteIds)
      case 'duplicate':
        return many ? undefined : deps.duplicate(first.id)
      case 'history':
        return many ? undefined : deps.history(first.id)
      case 'pin': {
        const next = !notes.every(pinnedNow)
        for (const id of noteIds) pinning.current.set(id, next)
        return deps.setPinned(noteIds, next).finally(() => {
          for (const id of noteIds) if (pinning.current.get(id) === next) pinning.current.delete(id)
        })
      }
      case 'trash':
        return deps.trash(noteIds)
      // Several notes only, and not templates (whose own tags are not used),
      // as the menu offers them; a key set for them does nothing otherwise.
      case 'addTag':
        return taggable(notes) ? setTagging({ mode: 'add', ids: noteIds }) : undefined
      case 'removeTag':
        return taggable(notes) && notes.some((n) => n.tagIds.length > 0)
          ? setTagging({ mode: 'remove', ids: noteIds })
          : undefined
      case 'status':
        return
      case 'copyLink':
        return copy(noteLinks(notes), many ? 'copyLinks' : 'copyLink')
      case 'copyUri':
      case 'copyId':
        if (many) return
        return copy(noteClipboardText(action as 'copyUri' | 'copyId', first), 'copy')
      default:
        // Export and print act on one note only.
        if (!many && (EXPORT_ACTIONS as readonly string[]).includes(action)) {
          return deps.exportNote(action as ExportAction, first.id)
        }
    }
  }

  const showMenu = useNoteMenu((action, target) => void runOn(action, target.ids))

  /** What the menu shows for these notes. */
  const menuTarget = (ids: readonly string[]): NoteMenuTarget => {
    const notes = listed(ids)
    const status = notes[0]?.status ?? null
    return {
      ids: notes.map((n) => n.id),
      pinned: notes.length > 0 && notes.every((n) => n.pinned),
      status: notes.every((n) => n.status === status) ? status : null,
      templates: notes.some((n) => n.bookId === TEMPLATES_BOOK_ID),
      tagged: notes.some((n) => n.tagIds.length > 0),
    }
  }

  const movingNotes = moving === undefined ? [] : listed(moving)
  const taggingNotes = tagging === undefined ? [] : listed(tagging.ids)
  // Notes that went away (trashed, say) take their picker with them for good.
  if (moving !== undefined && movingNotes.length === 0) setMoving(undefined)
  if (tagging !== undefined && taggingNotes.length === 0) setTagging(undefined)
  const movingFirst = movingNotes[0]
  const books = new Set(movingNotes.map((n) => n.bookId))
  const sharedBook = books.size === 1 ? movingFirst?.bookId : undefined
  const onNotes = new Set(taggingNotes.flatMap((n) => n.tagIds))

  return {
    run: (action: NoteAction, id: string) => runOn(action, idsFor(id)),
    runOn,
    menu: (id: string) => void showMenu(menuTarget(idsFor(id))),
    dialog: (
      <>
        {movingFirst ? (
          <MoveNoteDialog
            tree={deps.tree}
            title={movingFirst.title}
            detail={
              movingNotes.length > 1
                ? format(t('moveNote.detailMany'), {
                    notes: noteCount(movingNotes.length, currentLocale()),
                  })
                : undefined
            }
            // A template's notebook is not one to pick, so every option moves
            // it; so does any when the notes are in different notebooks.
            value={sharedBook === TEMPLATES_BOOK_ID ? undefined : sharedBook}
            onMove={(bookId) => {
              setMoving(undefined)
              void deps.move(
                movingNotes.map((n) => n.id),
                bookId,
              )
            }}
            onCancel={() => setMoving(undefined)}
          />
        ) : null}
        {tagging && taggingNotes.length > 0 ? (
          <TagPickDialog
            mode={tagging.mode}
            tags={
              tagging.mode === 'add' ? deps.tags : deps.tags.filter((tag) => onNotes.has(tag.id))
            }
            count={taggingNotes.length}
            onPick={(pick) => {
              setTagging(undefined)
              const ids = taggingNotes.map((n) => n.id)
              void (pick.tagId === null
                ? deps.addTag(ids, pick.name)
                : tagging.mode === 'add'
                  ? deps.putTag(ids, pick.tagId)
                  : deps.removeTag(ids, pick.tagId))
            }}
            onCancel={() => setTagging(undefined)}
          />
        ) : null}
      </>
    ),
  }
}
