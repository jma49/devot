import { useMemo, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { BookRecord, DailyNotesSettings, NoteSummary } from '../../../core'
import { headline } from '../../../core/extract'
import { noteLink } from '../../../core/links'
import { errorCode } from '../backups'
import type { Core } from '../core-client'
import type { EditorHandle } from '../editor/handle'
import { editorSettings } from '../editorSettings'
import { displayTitle, displayTitles, type HeadlineLoader } from '../headlines'
import { t } from '../i18n'
import { MAX_LINK_NOTES } from '../linkCompletion'
import { homeOf, viewLists, type ListView } from '../listUpdates'
import { startEarlyKeys } from '../editor/earlyKeys'
import { notebookForNewNote } from '../notebookChoices'
import { saveEdits } from '../saveGuards'
import type { Selection } from '../Sidebar'
import { useStable } from '../stable'
import { TemplatePicker } from '../TemplatePicker'
import { currentRecentTemplates } from '../templates'
import { track } from '../usage'
import type { useSearch } from '../useSearch'
import type { LibraryLists } from './useLibraryLists'
import type { ViewState } from './useLibraryView'
import type { useMode } from './useMode'
import { logFailure } from '../failure'

export const dailySettings = (): DailyNotesSettings => {
  const { dailyNotebook, dailyTemplate, dailyTitleFormat } = editorSettings()
  return { dailyNotebook, dailyTemplate, dailyTitleFormat }
}

/** New notes: blank, from a template, today's, a copy, or made from a selection or link in the open note. */
export function useNoteMaking({
  core,
  editing,
  lists,
  view: viewState,
  searchState,
  modes,
  showLibrary,
  select,
  selected,
  setSelected,
  builtIn,
  setBuiltIn,
  setTitle,
  opens,
  editorRef,
  setChangeNotice,
  loadHeadlines,
}: {
  core: Core | undefined
  editing: boolean
  lists: LibraryLists
  view: ViewState
  searchState: ReturnType<typeof useSearch>
  modes: ReturnType<typeof useMode>
  showLibrary: (next: Selection, options?: { clearFilter?: boolean }) => void
  select: (id: string, options?: { keyboard?: boolean }) => Promise<boolean>
  selected: string | undefined
  setSelected: Dispatch<SetStateAction<string | undefined>>
  builtIn: string | undefined
  setBuiltIn: Dispatch<SetStateAction<string | undefined>>
  setTitle: (title: string) => void
  opens: RefObject<number>
  editorRef: RefObject<EditorHandle | null>
  setChangeNotice: Dispatch<SetStateAction<string | undefined>>
  loadHeadlines: HeadlineLoader | undefined
}) {
  const { refresh, notes, templates, books } = lists
  const { inTrash, inTemplates, libraryBook, activeFilter, workspaceIds, setWorkspace } = viewState
  const { mode, setMode, editorMode } = modes
  // Template picker: recent ones are read on open; with `into`, the pick fills that empty note instead of making a new one.
  const [picking, setPicking] = useState<{ recent: string[]; into?: string }>()
  const recentTemplates = useMemo(() => currentRecentTemplates(), [])

  /**
   * Shows a note just made (`listed`: lists reloaded since). If the view would not list it, the view that does shows instead: its notebook, All Notes or Templates, without filter or search.
   */
  const showMade = async (
    c: Core,
    id: string,
    listed: {
      notes: NoteSummary[]
      templates: NoteSummary[]
      books: BookRecord[]
    },
  ) => {
    const made = listed.notes.find((n) => n.id === id) ?? listed.templates.find((n) => n.id === id)
    if (!made) return
    const latest = searchState.latestSearch.current
    if (latest.query.trim()) {
      const { found } = await c
        .search(latest.query, latest.scope)
        .catch(() => ({ found: [], capped: false }))
      if (found.some((n) => n.id === id)) return
    } else {
      const view: ListView = inTrash
        ? { kind: 'trash' }
        : inTemplates
          ? { kind: 'templates' }
          : {
              kind: 'library',
              bookId: libraryBook?.id ?? null,
              filter: activeFilter,
            }
      if (viewLists(view, made, listed.books)) return
    }
    showLibrary(homeOf(made), { clearFilter: true })
  }

  const newNoteBookId = () =>
    notebookForNewNote(
      libraryBook?.id,
      editorSettings().defaultNotebook,
      books.map((b) => b.id),
    )

  const create = async () => {
    if (!core) return
    const early = startEarlyKeys()
    let id: string
    try {
      // Save pending titles first, so the refreshed list shows them.
      await saveEdits(core)
      id = inTemplates ? await core.createTemplate() : await core.create('', newNoteBookId())
    } catch (e) {
      early.fail()
      setChangeNotice(logFailure(errorCode(e), 'W_NOTE_CREATE_FAILED'))
      return
    }
    early.claim(id)
    if (!inTemplates) track('note.created', { from: 'new_note' })
    await showMade(core, id, await refresh(core))
    // A new note is for typing: Preview alone would leave it without an editor.
    if (mode === 'preview') setMode(editorMode.current)
    await select(id, { keyboard: true })
  }

  /** Makes a note from a template and opens it (see `showMade`); the template's notebook, if any, wins over the one shown. */
  const createFromTemplate = async (templateId: string) => {
    setPicking(undefined)
    if (!core || !editing) return
    await saveEdits(core)
    const id = await core
      .applyTemplate(templateId, Date.now(), newNoteBookId())
      .catch((e: unknown) => {
        setChangeNotice(logFailure(errorCode(e), 'W_NOTE_CREATE_FAILED'))
        return undefined
      })
    if (!id) return console.warn('W_TEMPLATE_APPLY_FAILED', templateId)
    recentTemplates.use(templateId)
    track('note.created', { from: 'template' })
    // Its body, status and tags are written before the lists reload.
    await saveEdits(core)
    await showMade(core, id, await refresh(core))
    if (mode === 'preview') setMode(editorMode.current)
    await select(id, { keyboard: true })
  }

  /** Finds or makes today's note (dailyNotes.ts) and opens it; one outside the workspace leaves it. */
  const openToday = async () => {
    if (!core) return
    await saveEdits(core)
    let opened: { id: string; created: boolean; bookId: string | null }
    try {
      opened = await core.openTodaysNote(dailySettings(), Date.now(), editing)
    } catch (e) {
      setChangeNotice(logFailure(errorCode(e), 'W_NOTE_CREATE_FAILED'))
      return
    }
    if (opened.created) track('note.created', { from: 'today' })
    if (workspaceIds && !(opened.bookId !== null && workspaceIds.has(opened.bookId))) {
      setWorkspace(null)
    }
    await showMade(core, opened.id, await refresh(core))
    if (opened.created && mode === 'preview') setMode('edit')
    await select(opened.id, { keyboard: true })
  }

  /** Fills the open note from a template without making a new one; the open editor takes in the core's writes like another process's. */
  const fillFromTemplate = async (templateId: string, noteId: string) => {
    setPicking(undefined)
    if (!core || !editing) return
    await saveEdits(core)
    const navigation = opens.current
    const editor = editorRef.current?.noteId === noteId ? editorRef.current : null
    const done = await core
      .applyTemplateTo(templateId, noteId, Date.now())
      .then(() => true)
      .catch((e: unknown) => {
        setChangeNotice(logFailure(errorCode(e), 'W_NOTE_CREATE_FAILED'))
        return false
      })
    if (!done) return console.warn('W_TEMPLATE_APPLY_FAILED', templateId)
    recentTemplates.use(templateId)
    if (opens.current === navigation && editor && editorRef.current === editor) {
      const opened = await core.open(noteId, editor.vector()).catch(() => undefined)
      // The user asked for the fill, so Cmd+Z takes it back.
      if (opened && editorRef.current === editor) editor.takeStep(opened.state)
      const filled = await core.title(noteId).catch(() => undefined)
      if (filled !== undefined && opens.current === navigation) setTitle(filled)
    }
    await saveEdits(core)
    await refresh(core)
  }

  const setNoteDates = useStable(
    async (id: string, dates: { createdAt?: number; updatedAt?: number }) => {
      if (!core) return
      await core.setNoteDates(id, dates)
      await refresh(core)
    },
  )

  const editBuiltInCopy = async (id: string) => {
    if (!core || !editing) return
    await saveEdits(core)
    const copy = await core.saveTemplate(id, {}).catch(() => undefined)
    if (!copy) return console.warn('W_TEMPLATE_COPY_FAILED', id)
    setBuiltIn(undefined)
    await showMade(core, copy, await refresh(core))
    await select(copy, { keyboard: true })
  }
  const pickBuiltIn = (id: string) => {
    if (!editing) return
    setBuiltIn(undefined)
    return createFromTemplate(id)
  }
  const showBuiltIn = useStable((id: string) => {
    setSelected(undefined)
    setBuiltIn(id)
  })
  const shownBuiltIn = selected === undefined && inTemplates ? builtIn : undefined

  const duplicate = async (id: string) => {
    if (!core) return
    await saveEdits(core)
    const tagIds = [...notes, ...templates].find((n) => n.id === id)?.tagIds
    const copy = await core.duplicate(id, t('note.copySuffix'), tagIds).catch((e: unknown) => {
      const code = errorCode(e)
      console.warn('W_NOTE_DUPLICATE_FAILED', id, code)
      setChangeNotice(code)
    })
    if (!copy) return
    if (!templates.some((n) => n.id === id)) track('note.created', { from: 'duplicate' })
    await showMade(core, copy, await refresh(core))
    await select(copy)
  }

  /** Targets for the `[[` popup: search results, or the first notes of the list for no query. Runs on every key, so it saves nothing and takes no more than the popup shows. */
  const findLinkTargets = async (linkQuery: string) => {
    if (!core) return []
    const found = linkQuery
      ? (await core.search(linkQuery, undefined, { flush: false, shortInTitles: true })).found
      : await core.list(MAX_LINK_NOTES + 1)
    const targets = found.filter((n) => n.id !== selected)
    const named = await displayTitles(loadHeadlines, targets.slice(0, MAX_LINK_NOTES))
    return targets.map((n) => ({ ...n, title: named.get(n.id) ?? n.title }))
  }

  /**
   * New Note from Selection: the selection becomes a note (titled after its first line, in the open note's notebook) and a link replaces it as one undo step.
   * If the link cannot go in (text edited meanwhile, another note opened), the new note is deleted again.
   */
  const noteFromSelection = async (sourceId: string) => {
    const editor = editorRef.current
    if (!core || !editor) return
    let made: string | undefined
    const moved = await editor.moveSelection(async (text) => {
      const note = await core.extract(sourceId, text).catch((e: unknown) => {
        console.warn('W_NOTE_EXTRACT_FAILED', sourceId, errorCode(e))
      })
      if (!note) return null
      made = note.id
      return noteLink(displayTitle(note.title, headline(text)), note.id)
    })
    if (made === undefined) return
    if (moved) {
      track('note.created', { from: 'selection' })
    } else {
      const dropped = made
      console.warn('W_NOTE_EXTRACT_NOT_LINKED', sourceId, dropped)
      await dropNote(core, dropped)
    }
    // Edits save after a short delay (a title just typed, the link put in):
    // write them first, or the reload shows the notes as last stored.
    await saveEdits(core)
    await refresh(core)
  }

  /**
   * New Note from Link: the link at the caret becomes a note titled after its text, with the link's address as first line, and a note link replaces it as one undo step.
   * If the link cannot be replaced (edited meanwhile, another note opened), the new note is deleted again.
   */
  const noteFromLink = async (sourceId: string) => {
    const editor = editorRef.current
    const link = editor?.linkAtCursor()
    if (!core || !editor || !link) return
    let made: string | undefined
    const moved = await editor.moveRange(link.from, link.to, async () => {
      // Named in the same write: the lists read right after show the title.
      const note = await core.extract(sourceId, link.href, link.text).catch((e: unknown) => {
        console.warn('W_NOTE_EXTRACT_FAILED', sourceId, errorCode(e))
      })
      if (!note) return null
      made = note.id
      return noteLink(note.title, note.id)
    })
    if (made === undefined) return
    if (moved) {
      track('note.created', { from: 'link' })
    } else {
      const dropped = made
      console.warn('W_NOTE_EXTRACT_NOT_LINKED', sourceId, dropped)
      await dropNote(core, dropped)
    }
    // Edits save after a short delay (a title just typed, the link put in):
    // write them first, or the reload shows the notes as last stored.
    await saveEdits(core)
    await refresh(core)
  }

  const dropNote = (c: Core, id: string) =>
    c
      .trash(id)
      .then(() => c.purge(id))
      .catch(() => console.warn('W_NOTE_DROP_FAILED', id))

  const createLinkedNote = async (linkTitle: string) => {
    if (!core) throw new Error('E_CORE_NOT_READY')
    const id = await core.create(linkTitle, newNoteBookId())
    await refresh(core)
    return id
  }

  const discardLinkedNote = async (id: string) => {
    if (!core) return
    await dropNote(core, id)
    await refresh(core)
  }

  const templatePicker =
    core && picking ? (
      <TemplatePicker
        core={core}
        templates={templates}
        headlines={loadHeadlines}
        recent={picking.recent}
        books={books}
        bookId={libraryBook?.id ?? null}
        locales={viewState.locales}
        intoOpenNote={picking.into !== undefined}
        onCreate={(id) =>
          void (picking.into === undefined
            ? createFromTemplate(id)
            : fillFromTemplate(id, picking.into))
        }
        onCancel={() => setPicking(undefined)}
      />
    ) : null

  return {
    setPicking,
    recentTemplates,
    templatePicker,
    create,
    openToday,
    setNoteDates,
    editBuiltInCopy,
    pickBuiltIn,
    showBuiltIn,
    shownBuiltIn,
    duplicate,
    findLinkTargets,
    noteFromSelection,
    noteFromLink,
    createLinkedNote,
    discardLinkedNote,
  }
}
