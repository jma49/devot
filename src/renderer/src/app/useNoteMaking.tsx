import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react'
import { flushSync } from 'react-dom'
import type { BookRecord, DailyNotesSettings, NoteSummary } from '../../../core'
import { headline } from '../../../core/extract'
import { noteLink } from '../../../core/links'
import type { UsageProperties } from '../../../core/usage'
import { errorCode } from '../backups'
import type { Core } from '../core-client'
import type { EditorHandle } from '../editor/handle'
import { editorSettings } from '../editorSettings'
import { displayTitle, displayTitles, type HeadlineLoader } from '../headlines'
import { t } from '../i18n'
import { MAX_LINK_NOTES } from '../linkCompletion'
import { dropNote, linkedNoteCreate, linkedNoteDiscard } from '../linkedNotes'
import { homeOf, viewLists, type ListView } from '../listUpdates'
import { startEarlyKeys, takeEarlyKeys } from '../editor/earlyKeys'
import { keyboardIsFree } from '../focus'
import { notebookForNewNote } from '../notebookChoices'
import { saveEdits } from '../saveGuards'
import type { Selection } from '../Sidebar'
import { useStable } from '../stable'
import { currentRecentTemplates } from '../templates'
import { track } from '../usage'
import type { useSearch } from '../useSearch'
import type { LibraryLists } from './useLibraryLists'
import type { ViewState } from './useLibraryView'
import type { useMode } from './useMode'
import { logFailure } from '../failure'

const TemplatePicker = lazy(() =>
  import('../TemplatePicker').then((module) => ({ default: module.TemplatePicker })),
)

export const dailySettings = (): DailyNotesSettings => {
  const { dailyNotebook, dailyTemplate, dailyTitleFormat } = editorSettings()
  return { dailyNotebook, dailyTemplate, dailyTitleFormat }
}

const trackCreated = (from: UsageProperties<'note.created'>['from']) =>
  track('note.created', { from })

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
  const [making, setMaking] = useState(false)
  const activeMaking = useRef<((teardown?: boolean) => void) | undefined>(undefined)
  useEffect(() => () => activeMaking.current?.(true), [])

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
      const { found } = await c.search(latest.query, latest.scope).catch(() => ({ found: [] }))
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

  const reportCreateFailure = (e: unknown) =>
    setChangeNotice(logFailure(errorCode(e), 'W_NOTE_CREATE_FAILED'))

  const makeAndOpen = async (
    make: (c: Core) => Promise<string | undefined>,
    {
      previewMode = () => editorMode.current,
      onFailure = reportCreateFailure,
      onEmpty,
      collectKeys = true,
    }: {
      previewMode?: () => typeof mode | undefined
      onFailure?: (e: unknown) => void
      onEmpty?: () => void
      collectKeys?: boolean
    } = {},
  ) => {
    if (!core || activeMaking.current) return
    const early = collectKeys ? startEarlyKeys() : undefined
    const shownEditor = editorRef.current
    const endPause = shownEditor?.pauseForNewNote()
    let outcome: 'pending' | 'opened' | 'reopened' = 'pending'
    const isCurrent = () => activeMaking.current === end
    const end = (teardown = false) => {
      if (!isCurrent()) return
      activeMaking.current = undefined
      if (!teardown) flushSync(() => setMaking(false))
      if (outcome !== 'opened') endPause?.()
      if (outcome === 'pending') early?.fail()
      if (early && outcome === 'reopened' && shownEditor && editorRef.current === shownEditor) {
        shownEditor.type(takeEarlyKeys(shownEditor.noteId))
        if (keyboardIsFree()) shownEditor.focus()
      }
    }
    activeMaking.current = end
    setMaking(true)
    try {
      await saveEdits(core)
      if (!isCurrent()) return
      const id = await make(core)
      if (!isCurrent()) return
      if (!id) return onEmpty?.()
      early?.claim(id)
      const listed = await refresh(core)
      if (!isCurrent()) return
      await showMade(core, id, listed)
      if (!isCurrent()) return
      const nextMode = previewMode()
      if (mode === 'preview' && nextMode) setMode(nextMode)
      if (await (collectKeys ? select(id, { keyboard: true }) : select(id))) {
        outcome = shownEditor?.noteId === id ? 'reopened' : 'opened'
      }
    } catch (e) {
      if (isCurrent()) onFailure(e)
    } finally {
      end()
    }
  }

  const create = () =>
    makeAndOpen(async (c) => {
      const id = inTemplates ? await c.createTemplate() : await c.create('', newNoteBookId())
      if (!inTemplates) trackCreated('new_note')
      return id
    })

  /** Makes a note from a template and opens it (see `showMade`); the template's notebook, if any, wins over the one shown. */
  const createFromTemplate = (templateId: string) => {
    setPicking(undefined)
    if (!editing) return
    const warnApplyFailed = () => console.warn('W_TEMPLATE_APPLY_FAILED', templateId)
    return makeAndOpen(
      async (c) => {
        const id = await c.applyTemplate(templateId, Date.now(), newNoteBookId())
        if (!id) return undefined
        recentTemplates.use(templateId)
        trackCreated('template')
        await saveEdits(c)
        return id
      },
      {
        onFailure: (e) => {
          reportCreateFailure(e)
          warnApplyFailed()
        },
        onEmpty: warnApplyFailed,
      },
    )
  }

  /** Finds or makes today's note (dailyNotes.ts) and opens it; one outside the workspace leaves it. */
  const openToday = () => {
    let created = false
    return makeAndOpen(
      async (c) => {
        const opened = await c.openTodaysNote(dailySettings(), Date.now(), editing)
        created = opened.created
        if (opened.created) trackCreated('today')
        if (workspaceIds && !(opened.bookId !== null && workspaceIds.has(opened.bookId))) {
          setWorkspace(null)
        }
        return opened.id
      },
      { previewMode: () => (created ? 'edit' : undefined) },
    )
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
        reportCreateFailure(e)
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

  const editBuiltInCopy = (id: string) => {
    if (!editing) return
    const warnCopyFailed = () => console.warn('W_TEMPLATE_COPY_FAILED', id)
    return makeAndOpen(
      async (c) => {
        const copy = await c.saveTemplate(id, {})
        if (copy) setBuiltIn(undefined)
        return copy
      },
      {
        previewMode: () => undefined,
        onFailure: warnCopyFailed,
        onEmpty: warnCopyFailed,
      },
    )
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

  const duplicate = (id: string) =>
    makeAndOpen(
      async (c) => {
        const tagIds = [...notes, ...templates].find((n) => n.id === id)?.tagIds
        const copy = await c.duplicate(id, t('note.copySuffix'), tagIds)
        if (copy && !templates.some((n) => n.id === id)) trackCreated('duplicate')
        return copy
      },
      {
        collectKeys: false,
        previewMode: () => undefined,
        onFailure: (e) => {
          const code = errorCode(e)
          console.warn('W_NOTE_DUPLICATE_FAILED', id, code)
          setChangeNotice(code)
        },
      },
    )

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
      trackCreated('selection')
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
      trackCreated('link')
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

  const createLinkedNote = linkedNoteCreate(() => core, newNoteBookId, refresh)

  const discardLinkedNote = linkedNoteDiscard(() => core, refresh)

  const templatePicker =
    core && picking ? (
      <Suspense fallback={null}>
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
      </Suspense>
    ) : null

  return {
    making,
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
