import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import type { BookRecord, NoteSummary, TagRecord } from '../../core'
import type { NoteFilter } from '../../core/tags'
import { inEditor } from './commands/dispatch'
import type { Core } from './core-client'
import { keyboardIsFree } from './focus'
import {
  lastStateOf,
  restorePlan,
  type currentLastStateStore,
  type LastState,
  type NoteState,
  type ViewLayouts,
} from './lastState'
import type { Mode } from './ModeControl'
import type { EditorPlace } from './NoteEditor'
import type { Selection } from './Sidebar'
import { useStable } from './stable'

const LAST_STATE_SAVE_MS = 400

/**
 * The window's last state (lastState.ts): saved as the view, the open note and its place change,
 * and restored once the lists have loaded. Nothing is saved until the restore is done
 * (`restored`), so a loading window never overwrites it.
 */
export function useLastState({
  store,
  saved,
  core,
  listsLoaded,
  restored,
  setRestored,
  view: {
    library,
    filter,
    workspace,
    inTrash,
    inTemplates,
    bookId,
    activeFilter,
    mode,
    selected,
    workspaceId,
    layouts,
  },
  lists: { books, tags, notes, templates },
  query,
  setLibrary,
  setFilter,
  setWorkspace,
  select,
}: {
  store: ReturnType<typeof currentLastStateStore>
  saved: LastState | undefined
  core: Core | undefined
  listsLoaded: boolean
  restored: boolean
  setRestored: (done: boolean) => void
  view: {
    library: Selection
    filter: NoteFilter | null
    workspace: string | null
    inTrash: boolean
    inTemplates: boolean
    bookId: string | undefined
    activeFilter: NoteFilter | null
    mode: Mode
    selected: string | undefined
    workspaceId: string | undefined
    layouts: ViewLayouts
  }
  lists: {
    books: readonly BookRecord[]
    tags: readonly TagRecord[]
    notes: readonly NoteSummary[]
    templates: readonly NoteSummary[]
  }
  query: string
  setLibrary: Dispatch<SetStateAction<Selection>>
  setFilter: Dispatch<SetStateAction<NoteFilter | null>>
  setWorkspace: Dispatch<SetStateAction<string | null>>
  select: (id: string, options: { keyboard: boolean }) => Promise<boolean>
}) {
  const noteState = useRef<NoteState>(undefined)
  // The state outside the Trash, which is kept while the Trash shows.
  const libraryState = useRef<LastState>(undefined)
  // Restored note's place in editor and preview, applied once when it has loaded.
  const restoreEditor = useRef<{ id: string; place: Partial<EditorPlace> }>(undefined)
  const restorePreview = useRef<{ id: string; top: number }>(undefined)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const currentState = (): LastState | undefined => {
    const state = lastStateOf({
      inTrash,
      inTemplates,
      bookId,
      filter: activeFilter,
      mode,
      selected,
      workspace: workspaceId,
      boards: layouts.boards,
      galleries: layouts.galleries,
      note: noteState.current,
      beforeTrash: libraryState.current,
      keyboard: () => inEditor(document.activeElement),
    })
    if (!inTrash) libraryState.current = state
    return state
  }
  const saveNow = useStable(() => {
    clearTimeout(saveTimer.current)
    if (!restored) return
    const state = currentState()
    if (state) store.save(state)
  })
  const saveSoon = useCallback(() => {
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => saveNow(), LAST_STATE_SAVE_MS)
  }, [saveNow])
  useEffect(
    () => saveNow(),
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Each change of the state it saves is saved at once.
    [saveNow, restored, library, filter, selected, mode, workspace, layouts],
  )
  // So is the state when the page goes away or out of sight, and the
  // keyboard moving in or out of the editor soon after.
  useEffect(() => {
    const save = () => saveNow()
    window.addEventListener('pagehide', save)
    document.addEventListener('visibilitychange', save)
    document.addEventListener('focusin', saveSoon)
    return () => {
      window.removeEventListener('pagehide', save)
      document.removeEventListener('visibilitychange', save)
      document.removeEventListener('focusin', saveSoon)
      clearTimeout(saveTimer.current)
    }
  }, [saveNow, saveSoon])
  const editorPlaced = (id: string, place: EditorPlace) => {
    const known = noteState.current?.id === id ? noteState.current : { id, keyboard: false }
    noteState.current = {
      ...known,
      selection: place.selection,
      ...(place.top ? { editorTop: place.top } : {}),
    }
    saveSoon()
  }
  const previewScrolled = (top: number) => {
    if (selected === undefined) return
    const known = noteState.current?.id === selected ? noteState.current : undefined
    noteState.current = {
      ...(known ?? { id: selected, keyboard: false }),
      previewTop: top,
    }
    saveSoon()
  }
  // The view and filter the window started with: a view picked while it
  // loads is the user's, and the restore leaves it alone.
  const startView = useRef({ library, filter })
  // Restores the last state once the lists have loaded; a gone notebook, tag or note falls back to none. The restored note is the first Back/Forward entry.
  const restoreStarted = useRef(false)
  const restoreKeyboard = useRef<string>(undefined)
  useEffect(() => {
    if (restoreKeyboard.current !== selected) restoreKeyboard.current = undefined
  }, [selected])
  const restoreLast = async () => {
    try {
      const untouched =
        JSON.stringify({ library, filter }) === JSON.stringify(startView.current) &&
        selected === undefined
      const plan =
        saved && untouched
          ? restorePlan(saved, {
              books: new Set(books.map((b) => b.id)),
              tags: new Set(tags.map((tag) => tag.id)),
              notes: new Set([...notes, ...templates].map((n) => n.id)),
            })
          : undefined
      if (!plan) return
      setLibrary(plan.view)
      setFilter(plan.filter)
      setWorkspace(plan.workspace ?? null)
      const note = plan.note
      if (!note) return
      noteState.current = note
      const place: Partial<EditorPlace> = {}
      if (note.selection) place.selection = note.selection
      if (note.editorTop) place.top = note.editorTop
      restoreEditor.current = { id: note.id, place }
      const preview = mode === 'preview'
      if (preview && note.previewTop !== undefined) {
        restorePreview.current = { id: note.id, top: note.previewTop }
      }
      // The keyboard goes to the editor only while it is nobody's: a search
      // typed or focus put anywhere since launch is the user's, here and
      // once the editor has loaded (`restoreKeyboard`).
      const keyboard = note.keyboard && !preview && query === '' && keyboardIsFree()
      if (keyboard) restoreKeyboard.current = note.id
      await select(note.id, { keyboard })
    } catch {
      console.warn('W_LAST_STATE_RESTORE_FAILED')
    } finally {
      setRestored(true)
    }
  }
  useEffect(() => {
    if (!core || !listsLoaded || restoreStarted.current) return
    restoreStarted.current = true
    void restoreLast()
  })
  const takeEditorPlace = (id: string) => () => {
    const pending = restoreEditor.current
    restoreEditor.current = undefined
    return pending?.id === id ? pending.place : undefined
  }
  const takePreviewScroll = () => {
    const pending = restorePreview.current
    restorePreview.current = undefined
    return pending && pending.id === selected ? pending.top : undefined
  }

  return {
    saveNow,
    editorPlaced,
    previewScrolled,
    restoreKeyboard,
    takeEditorPlace,
    takePreviewScroll,
  }
}
