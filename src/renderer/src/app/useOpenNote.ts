import {
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react'
import { adjacentNote, stepTarget, trailTo, visit, type Trail } from '../../../core/navigation'
import { errorCode } from '../backups'
import { inEditor } from '../commands/dispatch'
import type { Core } from '../core-client'
import type { EditorHandle } from '../editor/handle'
import { invoke } from '../ipc'
import { openAfter, type ListSelection } from '../listSelection'
import { saveEdits } from '../saveGuards'
import { useStable } from '../stable'
import type { FocusRequest } from './focusRequest'
import type { LibraryLists } from './useLibraryLists'
import type { ViewState } from './useLibraryView'
import type { useMode } from './useMode'
import type { NoteOpening } from './useNoteOpening'
import type { useViewChanges } from './useViewChanges'

/** Opening, closing and stepping between notes, and where the keyboard goes once one is open. */
export function useOpenNote({
  core,
  selected,
  setSelected,
  setBuiltIn,
  setChangeNotice,
  opening: noteOpening,
  lists,
  view,
  viewChanges,
  modes,
  editorRef,
  paletteFromEditor,
  requestFocus,
}: {
  core: Core | undefined
  selected: string | undefined
  setSelected: Dispatch<SetStateAction<string | undefined>>
  setBuiltIn: Dispatch<SetStateAction<string | undefined>>
  setChangeNotice: Dispatch<SetStateAction<string | undefined>>
  opening: NoteOpening
  lists: LibraryLists
  view: ViewState
  viewChanges: ReturnType<typeof useViewChanges>
  modes: ReturnType<typeof useMode>
  editorRef: RefObject<EditorHandle | null>
  paletteFromEditor: RefObject<boolean>
  requestFocus: (request: FocusRequest) => void
}) {
  const { startOpening, stopOpening, opens, handOver, setShownNote, openingTitle, setTitle } =
    noteOpening
  const { trailRef, trail, moveTrail, openingRef } = noteOpening
  const { notes, templates } = lists
  const { setMulti, workspace, workspaceIds, setWorkspace, libraryBook, groups } = view
  const { listedIds, inTrash } = view
  const { firstNoteWanted, firstNoteDone, showLibrary } = viewChanges
  const { mode, setMode, editorMode } = modes
  // Note whose editor takes the keyboard on open: one just created, or opened by a palette action from the editor (opening from the list leaves it there).
  const [takesKeyboard, setTakesKeyboard] = useState<string>()
  /**
   * Opens a note; whether it opened. Its editor takes the keyboard only when
   * asked (`keyboard`: a note just created, or one opened by a key pressed
   * in the editor), or for one a palette action picked from the editor
   * opens. A note opened becomes the trail's newest entry, unless Back or
   * Forward opens it (`fromTrail`). An open overtaken by a later one (quick
   * key presses) leaves the selection to that one.
   */
  const select = async (
    id: string,
    {
      keyboard = false,
      fromTrail = false,
      keepSelection = false,
    }: {
      keyboard?: boolean
      fromTrail?: boolean
      keepSelection?: boolean
    } = {},
  ): Promise<boolean> => {
    if (!core) return false
    // Opening a note shows it alone, unless the selection itself moved the
    // open note (`keepSelection`).
    if (!keepSelection) setMulti(undefined)
    setBuiltIn(undefined)
    const open = startOpening(id)
    // Another note's body is asked for before its title, so it has usually
    // arrived with the title and shows in the same frame. A body later than
    // the title is left to the editor, which keeps the note on screen until then.
    const another = id !== selected
    let body: Uint8Array | undefined
    if (another) {
      void core.hold(id)
      core.open(id).then(
        (opened) => {
          body = opened.state
        },
        () => undefined,
      )
    }
    // A link may point at a note that is gone; leave the selection alone then.
    const name = await core.title(id).catch((e: unknown) => {
      console.warn('W_NOTE_OPEN_FAILED', id, errorCode(e))
      return undefined
    })
    // The note left is saved once this one has opened: its edits are in the core already,
    // which writes each note's in order, and again on quit, so the open need not wait.
    void saveEdits(core)
    const overtaken = open !== opens.current
    if (another && (overtaken || name === undefined || !body)) void core.unhold(id)
    if (overtaken) return false
    if (name === undefined) {
      stopOpening()
      return false
    }
    if (body) handOver({ core, noteId: id, state: body })
    setTakesKeyboard(keyboard || paletteFromEditor.current ? id : undefined)
    // Titles from other windows apply to this note from now on, before the render that selects it.
    setShownNote(id)
    setSelected(id)
    const relayed = openingTitle.current
    setTitle(relayed?.noteId === id ? relayed.title : name)
    if (!fromTrail) moveTrail(visit(trailRef.current, id))
    // A note opened outside the workspace (a note link, a search over every
    // note, the palette) leaves it.
    // A note just made is not listed in this render yet: it was made in the view shown.
    const opened = notes.find((n) => n.id === id) ?? templates.find((n) => n.id === id)
    if (workspaceIds && opened && !(opened.bookId && workspaceIds.has(opened.bookId))) {
      setWorkspace(null)
    }
    return true
  }

  useEffect(() => {
    if (!firstNoteWanted.current || !workspaceIds || libraryBook?.id !== workspace) return
    const open = notes.find((n) => n.id === selected)
    const first = groups.pinned[0] ?? groups.others[0]
    if ((open?.bookId && workspaceIds.has(open.bookId)) || !first) {
      firstNoteDone()
      return
    }
    const timer = setTimeout(() => {
      firstNoteDone()
      void select(first.id)
    })
    return () => clearTimeout(timer)
  })

  /** Saves first, so the note window reads what this window shows. */
  const openNoteWindow = async (id: string) => {
    if (core) await saveEdits(core)
    await invoke('note_window_open', { id }).catch((e: unknown) => {
      const code = errorCode(e)
      console.warn('W_NOTE_WINDOW_OPEN_FAILED', id, code)
      setChangeNotice(code)
    })
  }

  const closeNote = async () => {
    if (core) await saveEdits(core)
    setMulti(undefined)
    setBuiltIn(undefined)
    setSelected(undefined)
  }

  // Back/Forward entries skip deleted notes (the Trash's notes are never entries); templates are entries. The open note is the current entry's or the one a navigation is opening; none in the Trash.
  const liveIds = useMemo(
    () => new Set([...notes, ...templates].map((n) => n.id)),
    [notes, templates],
  )
  const onTrail = (now: Trail, opening?: string) => ({
    live: (id: string) => liveIds.has(id),
    current: opening ?? (inTrash || selected === undefined ? undefined : now.ids[now.at]),
  })
  const backAt = stepTarget(trail, -1, onTrail(trail))
  const forwardAt = stepTarget(trail, 1, onTrail(trail))
  const step = (by: -1 | 1) => {
    const now = trailRef.current
    const at = stepTarget(now, by, onTrail(now, openingRef.current))
    const id = at === undefined ? undefined : now.ids[at]
    if (at === undefined || id === undefined) return
    moveTrail(trailTo(now, at))
    const keyboard = inEditor(document.activeElement)
    if (inTrash) showLibrary({ kind: 'all' })
    return select(id, { keyboard, fromTrail: true })
  }
  const nextId = adjacentNote(listedIds, selected, 1)
  const previousId = adjacentNote(listedIds, selected, -1)
  /** Opens the next or previous note, stepping on from one a navigation is opening; from the editor it takes the keyboard there. */
  const openListed = (by: -1 | 1) => {
    const id = adjacentNote(listedIds, openingRef.current ?? selected, by)
    if (id === undefined) return
    if (!inTrash) return select(id, { keyboard: inEditor(document.activeElement) })
    startOpening(id)
    setMulti(undefined)
    setSelected(id)
  }
  /** Return or Cmd+Return on a list row: edit the open note's title or body (opening the row's note first). An editor still loading takes the keyboard when loaded. */
  const editNote = async (part: 'title' | 'body', id: string, start = false) => {
    const body = part === 'body'
    setMulti(undefined)
    if (id !== selected) {
      if (!(await select(id, { keyboard: body }))) return
    } else if (body && !editorRef.current) setTakesKeyboard(id)
    if (body && mode === 'preview') setMode(editorMode.current)
    requestFocus({ kind: part, id, start })
  }

  /** The editor could not open its note (gone or in the Trash): close it, so no editor shows a stale title and empty body. */
  const closeUnopenable = useStable((id: string, code: string) => {
    console.warn('W_NOTE_OPEN_FAILED', id, code)
    if (id === selected) setSelected(undefined)
  })

  /** One note left is the open note alone; with several, the open note stays open while selected, else the anchor opens (`openAfter`). Undefined (Escape) goes back to the open note alone. */
  const changeSelection = (next: ListSelection | undefined) => {
    if (!next) return setMulti(undefined)
    const open = next.ids.length > 1 ? openAfter(next, selected) : next.ids[0]
    if (open === undefined) return
    // The editor gives way to the summary; when it comes back, the list
    // keeps the keyboard (a new note's editor took it only once).
    if (next.ids.length > 1) setTakesKeyboard(undefined)
    setMulti(next.ids.length > 1 ? next : undefined)
    if (open === selected) return
    if (!inTrash) return void select(open, { keepSelection: true })
    startOpening(open)
    setSelected(open)
  }

  return {
    takesKeyboard,
    setTakesKeyboard,
    select,
    openNoteWindow,
    closeNote,
    backAt,
    forwardAt,
    step,
    nextId,
    previousId,
    openListed,
    editNote,
    closeUnopenable,
    changeSelection,
  }
}
