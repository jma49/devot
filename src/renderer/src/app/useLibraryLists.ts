import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react'
import type {
  BookRecord,
  NoteSummary,
  SavedSearchRecord,
  TagRecord,
  TrashedNote,
} from '../../../core'
import { compareNames } from '../../../core/sort'
import { errorCode } from '../backups'
import type { Core } from '../core-client'
import { NOTES_LOADED } from '../externalChanges'
import { markWrite } from '../lastWrite'
import { keepUnchanged, retitled, withWrites } from '../listUpdates'
import type { relayLink } from '../noteRelay'
import type { SearchResults } from '../useSearch'

/** A trashed note as a list row; rows that did not change keep their objects (keepUnchanged). */
const trashRow = (n: TrashedNote): NoteSummary => ({
  id: n.id,
  title: n.title,
  createdAt: n.deletedAt,
  updatedAt: n.deletedAt,
  bodyVersion: 0,
  bookId: n.bookId,
  status: 'none',
  pinned: false,
  tagIds: [],
})

/** The notes, notebooks, tags, saved searches and Trash as the core last listed them, with the writes and titles shown since. */
export function useLibraryLists({
  rerunSearch,
  setResults,
  listLibrary,
}: {
  rerunSearch: () => void
  setResults: Dispatch<SetStateAction<SearchResults | undefined>>
  /** The notes and templates from the page's own storage, so the list is not copied to the core worker and back. */
  listLibrary: () => Promise<{ notes: NoteSummary[]; templates: NoteSummary[] }>
}) {
  const [listsLoaded, setListsLoaded] = useState(false)
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [books, setBooks] = useState<BookRecord[]>([])
  const [tags, setTags] = useState<TagRecord[]>([])
  const [savedSearches, setSavedSearches] = useState<SavedSearchRecord[]>([])
  const [trash, setTrash] = useState<TrashedNote[]>([])
  const [trashRows, setTrashRows] = useState<NoteSummary[]>([])
  const [templates, setTemplates] = useState<NoteSummary[]>([])

  // Moves when this device's agent_writes rows may have changed: a reload of the lists, or a write that changed a note's rows.
  const [authorship, setAuthorship] = useState(0)
  const authorshipChanged = useCallback(() => setAuthorship((n) => n + 1), [])

  const refresh = useCallback(
    async (c: Core) => {
      const [listed, nextBooks, nextTags, nextTrash, nextSearches] = await Promise.all([
        listLibrary(),
        c.listBooks(),
        c.listTags(),
        c.listTrash(),
        c.listSavedSearches(),
      ])
      const nextNotes = listed.notes
      setTrash(nextTrash)
      setTrashRows((prev) => keepUnchanged(prev, nextTrash.map(trashRow)))
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
      return { notes: nextNotes, templates: listed.templates, books: nextBooks, trash: nextTrash }
    },
    [authorshipChanged, rerunSearch, listLibrary],
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
  const reloadStarted = () => {
    reloadsPending.current += 1
  }
  const reloadDone = () => {
    reloadsPending.current -= 1
  }

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

  return {
    listsLoaded,
    setListsLoaded,
    notes,
    books,
    tags,
    savedSearches,
    trash,
    trashRows,
    templates,
    authorship,
    authorshipChanged,
    refresh,
    reloadStarted,
    reloadDone,
    showWrites,
    retitleListed,
  }
}

export type LibraryLists = ReturnType<typeof useLibraryLists>

/** A note window's changes: its core takes them in, and the lists show its saves and titles. */
export function useNoteWindowChanges({
  core,
  relay,
  lists,
  knownNotes,
}: {
  core: Core | undefined
  relay: { link: ReturnType<typeof relayLink> }
  lists: LibraryLists
  knownNotes: RefObject<ReadonlyMap<string, NoteSummary>>
}) {
  const { showWrites, retitleListed, refresh, authorshipChanged } = lists
  useEffect(() => {
    if (!core) return
    const listening = relay.link.listen((message) => {
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
        void core.mirrorTouch([message.noteId])
      } else if (message.kind === 'title') {
        retitleListed(message.noteId, message.title)
      }
    })
    return () => void listening.then((stop) => stop())
  }, [core, relay, showWrites, retitleListed, refresh, authorshipChanged, knownNotes])
}
