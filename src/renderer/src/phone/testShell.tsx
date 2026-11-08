// For the phone shell's tests only: the real core over the UI tests' storage (storage/memory.ts),
// the lists it reads, and an editor stand-in that records the keyboard it is given.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { createBookService } from '../../../core/books'
import { createClock } from '../../../core/hlc'
import { createIdGenerator } from '../../../core/ids'
import { createNoteService } from '../../../core/notes/service'
import { createTagService } from '../../../core/tags'
import { createTemplateService } from '../../../core/templates'
import type { Core } from '../core-client'
import type { EarlyKey } from '../editor/earlyKeys'
import type { EditorHandle } from '../editor/handle'
import { memoryStorage } from '../storage/memory'
import type { PhoneData, PhoneStore } from './usePhoneData'

export function testCore() {
  const clock = createClock('phone1')
  const newId = createIdGenerator()
  const storage = memoryStorage
  const notes = createNoteService({ storage, clock, newId, saveDelayMs: 5 })
  const books = createBookService({ storage, clock, newId })
  const tags = createTagService({ storage, clock, newId })
  const templates = createTemplateService({ storage, notes, books, tags, clock, newId })
  const named: Record<string, unknown> = {
    createTemplate: () => templates.create(),
    listWithTemplates: () => templates.listWithNotes(),
    listBooks: () => books.list(),
    createBook: (name: string, parentId: string | null) => books.create(name, parentId),
    listTags: () => tags.list(),
    addTag: (noteId: string, name: string) => tags.addToNote(noteId, name),
    removeTag: (noteId: string, tagId: string) => tags.removeFromNote(noteId, tagId),
    listSavedSearches: async () => [],
    history: async () => [],
    backlinks: async () => [],
    // Preview is drawn behind Edit; a result it cannot read would make it render again forever.
    renderLivePreview: async () => ({
      pieces: [],
      tasks: { done: 0, total: 0 },
      lines: 0,
      links: [],
    }),
  }
  // What the screens ask of the core besides these goes to the note service, or finds nothing.
  const core = new Proxy(named, {
    get: (target, key) => {
      if (key in target) return target[key as string]
      const own = (notes as unknown as Record<string | symbol, unknown>)[key]
      return typeof own === 'function' ? own.bind(notes) : async () => undefined
    },
  }) as unknown as Core & Record<string, (...args: never[]) => Promise<unknown>>
  return { notes, books, tags, templates, core }
}

let shownCore: Core | null = null

/** The core `useTestPhoneData` reads its lists from, set before the shell renders. */
export function setTestCore(core: Core | null): void {
  shownCore = core
}

const EMPTY: Omit<PhoneData, 'core'> = {
  notes: [],
  templates: [],
  books: [],
  tags: [],
  savedSearches: [],
  trash: [],
  lastBackup: null,
  loadedAt: 0,
}

/** Stands in for usePhoneData: the same lists, read from the core `setTestCore` set after each change. */
export function useTestPhoneData(): PhoneStore {
  const [data, setData] = useState<PhoneData>({ ...EMPTY, core: null })
  const refresh = useCallback(async () => {
    const core = shownCore
    if (!core) return
    await core.flush()
    const [listed, books, tags, trash] = await Promise.all([
      core.listWithTemplates(),
      core.listBooks(),
      core.listTags(),
      core.listTrash(),
    ])
    setData({ ...EMPTY, core, ...listed, books, tags, trash, loadedAt: Date.now() })
  }, [])
  useEffect(() => void Promise.resolve().then(refresh), [refresh])
  const started = useCallback(
    async () => shownCore ?? Promise.reject(new Error('E_SCREENS_UNAVAILABLE')),
    [],
  )
  return { ...data, refresh, onTakenIn: () => () => {}, started }
}

export interface ShownEditor {
  readonly noteId: string
  focused: number
  typed: EarlyKey[]
  text: (text: string) => void
}

export const shownEditors: ShownEditor[] = []

/** Stands in for NoteEditor: loads an empty body and records what focuses it and what is typed. */
export function TestEditor({
  noteId,
  handleRef,
  ...props
}: {
  noteId: string
  onText: (read: () => string) => void
  onLoaded?: (text: string) => void
  handleRef?: RefObject<EditorHandle | null>
}) {
  const latest = useRef(props)
  useEffect(() => {
    latest.current = props
  })
  useEffect(() => {
    const shown: ShownEditor = {
      noteId,
      focused: 0,
      typed: [],
      text: (text) => latest.current.onText(() => text),
    }
    shownEditors.push(shown)
    if (handleRef)
      handleRef.current = {
        noteId,
        focusStart: () => void (shown.focused += 1),
        type: (keys: readonly EarlyKey[]) => void shown.typed.push(...keys),
      } as unknown as EditorHandle
    latest.current.onLoaded?.('')
  }, [noteId, handleRef])
  return <div className="cm-editor" />
}
