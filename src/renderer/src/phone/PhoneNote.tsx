import {
  useCallback,
  useDeferredValue,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { createAiGenerator } from '../../../core/aiProvider'
import { createSuggester } from '../../../core/aiSuggest'
import { noteCounts } from '../../../core/noteCounts'
import { tagCounts } from '../../../core/tags'
import { TEMPLATES_BOOK_ID } from '../../../core/templatesBook'
import { aiTransport } from '../ai'
import { aiSuggestFailure } from '../aiEditView'
import { licenceEntitlements, useEditing } from '../licence'
import { loadAiSettings } from '../settings/aiProviders'
import { useAlertMenu } from '../editor/alertMenu'
import { noteDate } from '../format'
import { format, currentLocale, t } from '../i18n'
import { Icon } from '../icons/Icon'
import { rememberTag } from '../quickTag'
import { tagColorClass, tagColorStyle } from '../tagColorStyle'
import type { LinkSources } from '../linkCompletion'
import { linkedNoteCreate, linkedNoteDiscard } from '../linkedNotes'
import type { EarlyKey } from '../editor/earlyKeys'
import type { EditorHandle } from '../editor/handle'
import { motionReduced } from '../motionPreference'
import { motionMs } from '../motionTiming'
import type { Core } from '../core-client'
import { NoteEditor } from '../NoteEditor'
import type { FindTarget } from '../find/target'
import { Preview } from '../preview/Preview'
import { notebookPath } from './library'
import { crossfadePanes } from './modeCrossfade'
import { useNoteStats } from './noteStats'
import {
  NotebookPicker,
  STATUS_LABEL,
  StatusMark,
  StatusPicker,
  statusTile,
  TagPicker,
} from './pickers'
import { PhoneDetailSheet } from './PhoneSheet'
import { requireEditing, watchWrite } from './requireEditing'
import type { PhoneStore } from './usePhoneData'
import {
  NO_FIND_COUNT,
  runFind,
  type BarFormat,
  type FindAction,
  type FindCount,
} from './screens/editor'
import type { EditorMode, EditorNoteFacts, EditorPicker } from './screens/message'
import { NOTE_PAGE_SCROLLS } from './screens/pageScroll'

type Sheet = 'notebook' | 'status' | 'tags' | null

const PICKER_OPS = {
  notebook: 'move',
  status: 'status',
  tags: 'tags',
} as const

/** A note New Note just made, whose body takes the keyboard once its push has landed. */
export interface NewNoteArrival {
  /**
   * What was typed since the tap, or null once the keyboard has been handed over. Text still being
   * composed then comes later, through `typeLater`.
   */
  takeTyped: (typeLater: (keys: readonly EarlyKey[]) => void) => readonly EarlyKey[] | null
  /** Anything the user put in the note, so leaving it keeps it. */
  onTouched: () => void
}

/** What the native editor screen runs on the note it shows. */
export interface NoteCommands {
  readonly setMode: (mode: EditorMode) => void
  readonly format: (id: BarFormat) => void
  readonly ai: (action: 'suggest' | 'accept') => void
  /** Find works in Edit, so a search shows the editor until `close`. */
  readonly find: (action: FindAction, query: string) => FindCount | Promise<FindCount>
  readonly duplicate: () => Promise<{ id: string; title: string } | null>
  /** The screen went: sheets, Find and the keyboard go with it. */
  readonly leave: () => void
  /** Puts the caret at the start of the body, in Edit only; whether it took it. */
  readonly focusBody: () => boolean
}

/**
 * The note inside the native editor screen, which draws the bars, the find bar and the sheets: Back
 * pops the screen, a link pushes another, and the page reports what the bars show.
 */
export interface NativeNoteChrome {
  readonly openNote: (id: string) => void
  readonly loaded: (id: string) => void
  readonly openFailed: (id: string) => void
  readonly mode: (id: string, mode: EditorMode) => void
  readonly title: (id: string, title: string) => void
  readonly titleVisible: (visible: boolean) => void
  /** What the More menu and the pickers show of the note, again whenever it changes. */
  readonly facts: (facts: EditorNoteFacts) => void
  /** A chip was tapped: Swift opens its picker. */
  readonly picker: (noteId: string, picker: EditorPicker) => void
  readonly commands: RefObject<NoteCommands | null>
  /** Counts Swift's shows: each comes with a new screen, so the page reports the bar's state again. */
  readonly turn: number
}

// A push that ends without a transitionend (the layer was already in place) still lands.
const LANDING_MARGIN_MS = 100
// A big note can take seconds to load; a search asked meanwhile gives up after this.
const FIND_WAIT_MS = 5000

/** Whether the screen's layer has finished sliding in: at once for a screen that did not arrive. */
function useLanded(screen: RefObject<HTMLElement | null>, arriving: boolean): boolean {
  const [landed, setLanded] = useState(!arriving)
  useEffect(() => {
    if (landed) return
    const layer = screen.current?.closest<HTMLElement>('.phone-layer')
    const land = () => setLanded(true)
    const onEnd = (event: Event) => {
      if (event.target === layer) land()
    }
    layer?.addEventListener('transitionend', onEnd)
    const duration = motionReduced()
      ? motionMs('motion.duration.phone-crossfade')
      : motionMs('motion.duration.phone-push')
    const timer = setTimeout(land, duration + LANDING_MARGIN_MS)
    return () => {
      layer?.removeEventListener('transitionend', onEnd)
      clearTimeout(timer)
    }
  }, [landed, screen])
  return landed
}

export function PhoneNote(props: {
  store: PhoneStore
  noteId: string
  onBack: () => void
  arrival?: NewNoteArrival
  native?: NativeNoteChrome
  takePreopened?: (core: Core, noteId: string) => Uint8Array | undefined
}) {
  const { store, arrival, native } = props
  const screen = useRef<HTMLElement>(null)
  const landed = useLanded(screen, arrival !== undefined)
  const [loadedId, setLoadedId] = useState<string | null>(null)
  const touched = (id: string) => {
    if (id === props.noteId) arrival?.onTouched()
  }
  // The web fallback's links push onto a trail that its Back walks down.
  const [trail, setTrail] = useState<readonly string[]>([props.noteId])
  const noteId = native ? props.noteId : trail[trail.length - 1]!
  const note =
    store.notes.find((n) => n.id === noteId) ?? store.templates.find((n) => n.id === noteId)
  const [modes, setModes] = useState<Readonly<Record<string, 'edit' | 'preview'>>>({})
  const editing = useEditing()
  const setMode = (next: 'edit' | 'preview') => setModes((m) => ({ ...m, [noteId]: next }))
  const [toggles, setToggles] = useState(0)
  const [moving, setMoving] = useState(false)
  const editLayer = useRef<HTMLDivElement>(null)
  const previewLayer = useRef<HTMLDivElement>(null)
  const band = useRef<HTMLDivElement>(null)
  const headingField = useRef<HTMLDivElement>(null)
  const [body, setBody] = useState({ id: noteId, text: '' })
  const text = body.id === noteId ? body.text : ''
  // Preview stays drawn behind Edit, a step behind the typing.
  const previewText = useDeferredValue(text)
  const counter = store.core
  const countNote = useCallback(
    (markdown: string) => counter?.noteCounts(markdown) ?? noteCounts(markdown),
    [counter],
  )
  const stats = useNoteStats(noteId, text, countNote)
  const [sheet, setSheet] = useState<Sheet>(null)
  const [titleDraft, setTitleDraft] = useState<string | null>(null)
  const [suggestFailure, setSuggestFailure] = useState<string>()
  const [finding, setFinding] = useState(false)
  const findTarget = useRef<FindTarget | null>(null)
  const pendingFind = useRef<{ query: string; answer: (count: FindCount) => void } | null>(null)
  const takeFindTarget = useCallback((target: FindTarget | null) => {
    findTarget.current = target
    const pending = pendingFind.current
    if (!target || !pending) return
    pendingFind.current = null
    pending.answer(runFind(target, 'search', pending.query))
  }, [])
  // A locked note stays in Preview; only Find shows its editor, which then takes no caret.
  const mode = editing || finding ? (modes[noteId] ?? 'preview') : 'preview'
  const titleField = useRef<HTMLTextAreaElement>(null)
  const editor = useRef<EditorHandle | null>(null)
  const showAlertMenu = useAlertMenu()
  // An editor being left reports an empty body as it goes: only its own note's body takes that.
  const showText = (id: string, next: string) => {
    if (next !== '') touched(id)
    setBody((shown) => (shown.id === id ? { id, text: next } : shown))
  }
  const noteLoaded = (id: string, loaded: string) => {
    setLoadedId(id)
    native?.loaded(id)
    setBody({ id, text: loaded })
    // An empty note has nothing to read, so it opens ready to write.
    setModes((m) => (m[id] ? m : { ...m, [id]: loaded === '' ? 'edit' : 'preview' }))
  }

  // A toggle crossfades; a note shown in its other mode simply shows it.
  const shownMode = useRef({ noteId, mode })
  useLayoutEffect(() => {
    const before = shownMode.current
    shownMode.current = { noteId, mode }
    if (before.noteId !== noteId || before.mode === mode) return
    const incoming = mode === 'edit' ? editLayer.current : previewLayer.current
    const outgoing = mode === 'edit' ? previewLayer.current : editLayer.current
    if (!incoming || !outgoing) return
    let current = true
    setMoving(true)
    void crossfadePanes(incoming, outgoing, motionReduced()).then(() => {
      if (current) setMoving(false)
    })
    return () => {
      current = false
    }
  }, [noteId, mode])

  // `native` is new on each show, so each new screen hears the mode, the title and the scroll.
  useEffect(() => {
    native?.mode(noteId, mode)
  }, [native, noteId, mode])

  const shownTitle = titleDraft ?? note?.title
  const noteShown = note !== undefined
  useEffect(() => {
    if (shownTitle !== undefined) native?.title(noteId, shownTitle)
  }, [native, noteId, shownTitle])

  const factsKey = note
    ? [
        note.id,
        note.bookId,
        note.status,
        note.pinned,
        note.tagIds.join(' '),
        note.createdAt,
        note.updatedAt,
      ]
        .map(String)
        .join('|')
    : null
  const shownNote = useRef(note)
  useLayoutEffect(() => {
    shownNote.current = note
  })
  useEffect(() => {
    const shown = shownNote.current
    if (!native || factsKey === null || !shown) return
    native.facts({
      id: shown.id,
      bookId: shown.bookId,
      status: shown.status,
      pinned: shown.pinned,
      tagIds: [...shown.tagIds],
      createdAt: shown.createdAt,
      updatedAt: shown.updatedAt,
    })
  }, [native, factsKey])

  // The bar takes the title once the note's own has scrolled under it.
  const scrolledTurn = useRef<number | null>(null)
  useLayoutEffect(() => {
    const element = screen.current?.querySelector<HTMLElement>('.phone-note-scroll')
    if (!native || !noteShown || !element) return
    const scroller = NOTE_PAGE_SCROLLS ? window : element
    // Each screen Swift pushes opens its note at the top, the note shown last too.
    if (scrolledTurn.current !== native.turn) scroller.scrollTo(0, 0)
    scrolledTurn.current = native.turn
    let visible: boolean | null = null
    const check = () => {
      const bar = band.current?.getBoundingClientRect().bottom ?? 0
      const next = (headingField.current?.getBoundingClientRect().bottom ?? 0) > bar
      if (next === visible) return
      visible = next
      native.titleVisible(next)
    }
    check()
    scroller.addEventListener('scroll', check, { passive: true })
    return () => scroller.removeEventListener('scroll', check)
  }, [native, noteShown])

  const suggester = useMemo(() => {
    const core = store.core
    if (!core) return undefined
    return createSuggester({
      generator: createAiGenerator({
        storage: { listBooks: () => core.listBooks() },
        transport: aiTransport,
        entitlements: licenceEntitlements,
      }),
      bookOf: async (id) => (await core.read(id)).bookId,
      listBooks: () => core.listBooks(),
      settings: loadAiSettings,
      entitlements: licenceEntitlements,
    })
  }, [store.core])

  useEffect(() => {
    if (!landed || loadedId !== props.noteId || noteId !== props.noteId) return
    const shown = editor.current
    const typed = shown
      ? arrival?.takeTyped((late) => {
          if (late.length && editor.current === shown) shown.type(late)
        })
      : null
    if (!typed || !shown) return
    shown.focusStart()
    if (typed.length) shown.type(typed)
  }, [arrival, landed, loadedId, noteId, props.noteId])

  useImperativeHandle(native?.commands, (): NoteCommands => ({
    setMode: (next) => {
      const turn = () => {
        setToggles((n) => n + 1)
        setMode(next)
      }
      if (next === 'edit') requireEditing({ op: 'edit', id: noteId }, turn)
      else turn()
    },
    format: (id) => requireEditing({ op: 'edit', id: noteId }, () => editor.current?.format(id)),
    ai: (action) =>
      requireEditing({ op: 'ai', id: noteId }, () =>
        action === 'suggest' ? editor.current?.suggest() : editor.current?.acceptSuggestion(),
      ),
    find: (action, query) => {
      if (action === 'search') {
        setMode('edit')
        setFinding(true)
      }
      if (action === 'close') setFinding(false)
      const target = findTarget.current
      pendingFind.current?.answer(NO_FIND_COUNT)
      pendingFind.current = null
      if (target || action !== 'search') return runFind(target, action, query)
      // A query typed while the note still loads runs once its editor can search it.
      return new Promise<FindCount>((resolve) => {
        const timer = setTimeout(() => {
          if (pendingFind.current?.answer !== answer) return
          pendingFind.current = null
          resolve(NO_FIND_COUNT)
        }, FIND_WAIT_MS)
        const answer = (count: FindCount) => {
          clearTimeout(timer)
          resolve(count)
        }
        pendingFind.current = { query, answer }
      })
    },
    duplicate: async () => {
      const core = store.core
      if (!core || !note) return null
      const id = await core.duplicate(note.id, t('note.copySuffix'), [...note.tagIds])
      return { id, title: (await core.read(id)).title }
    },
    focusBody: () => {
      const shown = editor.current
      if (!editing || mode !== 'edit' || !shown) return false
      shown.focusStart()
      return true
    },
    leave: () => {
      setSheet(null)
      setFinding(false)
      const focused = document.activeElement
      if (focused instanceof HTMLElement && screen.current?.contains(focused)) focused.blur()
    },
  }))

  const { onTakenIn } = store
  useEffect(
    () =>
      onTakenIn((change) => {
        const shown = editor.current
        if (change.kind === 'update' && shown?.noteId === change.noteId) {
          shown.takeState(change.update)
        }
      }),
    [onTakenIn],
  )

  const openNote = (id: string) => (native ? native.openNote(id) : setTrail((ids) => [...ids, id]))
  const links: LinkSources = {
    find: async (query) => {
      const core = store.core
      if (!core) return []
      const found = query
        ? (await core.search(query, undefined, { flush: false })).found
        : store.notes
      return found
        .filter((n) => n.id !== noteId)
        .slice(0, 20)
        .map((n) => ({ id: n.id, title: n.title || t('note.untitled') }))
    },
    create: linkedNoteCreate(
      () => store.core,
      () => note?.bookId ?? null,
    ),
    discard: linkedNoteDiscard(() => store.core),
    linked: () => {},
  }

  if (!note || !store.core)
    return (
      <section ref={screen} aria-label={t('phone.note')} className="phone-screen">
        {native ? null : (
          <header className="phone-topbar">
            <button
              type="button"
              className="phone-glass phone-nav-control"
              aria-label={t('phone.back')}
              onClick={props.onBack}
            >
              <Icon name="nav.back" size="lg" />
            </button>
          </header>
        )}
      </section>
    )

  const core = store.core
  const book = store.books.find((b) => b.id === note.bookId)
  const crumb = notebookPath(store.books, note.bookId)
  const tags = note.tagIds
    .map((id) => store.tags.find((tag) => tag.id === id))
    .filter((tag) => tag !== undefined && tag.deletedAt === null)
  const title = titleDraft ?? note.title
  const back = () => (trail.length > 1 ? setTrail((ids) => ids.slice(0, -1)) : props.onBack())
  // The native screen's pickers ask for Devot Pro when they write, not when they open.
  const pick = (picker: EditorPicker) =>
    native
      ? native.picker(note.id, picker)
      : requireEditing({ op: PICKER_OPS[picker], id: note.id }, () => setSheet(picker))

  return (
    <section ref={screen} aria-label={note.title || t('note.untitled')} className="phone-screen">
      <div className="phone-scroll phone-note-scroll">
        <div ref={headingField} className="phone-note-heading-field" data-title={title}>
          <textarea
            ref={titleField}
            className="phone-note-heading"
            rows={1}
            readOnly={!editing}
            aria-label={t('phone.note.title')}
            placeholder={t('note.untitled')}
            value={title}
            onChange={(event) => {
              touched(note.id)
              setTitleDraft(event.target.value.replace(/[\r\n]+/g, ' '))
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.preventDefault()
            }}
            onClick={() => {
              if (!editing)
                requireEditing({ op: 'title', id: note.id }, () => titleField.current?.focus())
            }}
            onBlur={() => {
              if (titleDraft !== null && titleDraft !== note.title)
                watchWrite('title', core.setTitle(note.id, titleDraft))
              setTitleDraft(null)
            }}
          />
        </div>
        <div className="phone-chips phone-note-chips">
          <button type="button" className="phone-chip-target" onClick={() => pick('notebook')}>
            <span className="phone-chip">
              <Icon name="notebook" size="sm" />
              <span className="phone-chip-text">{book?.name ?? t('phone.noNotebook')}</span>
              <Icon name="popup.chevron" size="xs" />
            </span>
          </button>
          <button type="button" className="phone-chip-target" onClick={() => pick('status')}>
            <span
              className="phone-chip phone-chip-strong"
              style={{ background: statusTile(note.status) }}
            >
              <StatusMark status={note.status} />
              {t(STATUS_LABEL[note.status])}
              <Icon name="popup.chevron" size="xs" />
            </span>
          </button>
          {tags.map((tag) => (
            <button
              key={tag!.id}
              type="button"
              className="phone-chip-target"
              onClick={() => pick('tags')}
            >
              <span
                className={`phone-chip ${tagColorClass(tag!.color)}`}
                data-tag={tag!.color ?? undefined}
                style={tagColorStyle(tag!.color)}
              >
                <span className="phone-chip-text">{tag!.name}</span>
              </span>
            </button>
          ))}
          <button type="button" className="phone-chip-target" onClick={() => pick('tags')}>
            <span className="phone-chip phone-chip-dashed">
              <Icon name="notebook.new" size="xs" />
              {t('phone.note.tag')}
            </span>
          </button>
        </div>
        <p className="phone-note-caption phone-figures">
          {format(t('phone.note.caption'), {
            time: noteDate(note.updatedAt, store.loadedAt, currentLocale()),
            count: stats.words.toLocaleString(currentLocale()),
          })}
        </p>
        <div className="phone-note-body" data-mode={mode}>
          <div
            ref={editLayer}
            className="phone-note-layer"
            data-shown={mode === 'edit' || undefined}
            data-resting={(mode === 'preview' && !moving) || undefined}
            inert={mode !== 'edit'}
          >
            <NoteEditor
              // The native screen swaps notes into one editor; the web stack draws one per note.
              key={native ? undefined : noteId}
              core={core}
              noteId={noteId}
              autoFocus={false}
              hidden={mode === 'preview' && !moving}
              {...(props.takePreopened ? { takePreopened: props.takePreopened } : {})}
              readOnly={!editing}
              noKeyboard
              onText={(read) => showText(noteId, read())}
              onLoaded={(loaded) => noteLoaded(noteId, loaded)}
              onOpenFailed={(id) => native?.openFailed(id)}
              links={links}
              showAlertMenu={showAlertMenu}
              handleRef={editor}
              onOpenNote={openNote}
              onFind={takeFindTarget}
              suggester={suggester}
              onSuggestFailed={setSuggestFailure}
            />
          </div>
          <div
            ref={previewLayer}
            className="phone-note-layer phone-note-preview"
            data-shown={mode === 'preview' || undefined}
            data-resting={(mode === 'edit' && !moving) || undefined}
            inert={mode !== 'preview'}
          >
            <Preview
              core={core}
              markdown={mode === 'preview' ? text : previewText}
              frontMatterInInfo={native !== undefined && note?.bookId !== TEMPLATES_BOOK_ID}
              onOpenNote={openNote}
              onToggleTask={(at) =>
                requireEditing({ op: 'task', id: noteId }, () => editor.current?.toggleTask(at))
              }
            />
          </div>
        </div>
      </div>
      <div
        ref={band}
        aria-hidden="true"
        className="phone-topbar-band"
        data-native={native ? '' : undefined}
      />
      {native ? null : (
        <header className="phone-topbar">
          <button
            type="button"
            className="phone-glass phone-nav-control"
            aria-label={t('phone.back')}
            onClick={back}
          >
            <Icon name="nav.back" size="lg" />
          </button>
          <span className="phone-note-crumb phone-mono">{crumb}</span>
          <div className="phone-glass phone-capsule">
            <button
              type="button"
              className="phone-capsule-button phone-mode-toggle"
              aria-label={t(mode === 'edit' ? 'phone.note.preview' : 'phone.note.edit')}
              aria-pressed={mode === 'preview'}
              data-turn={toggles === 0 ? undefined : toggles % 2 ? 'a' : 'b'}
              onClick={() => {
                const next = mode === 'edit' ? 'preview' : 'edit'
                const turn = () => {
                  setToggles((n) => n + 1)
                  setMode(next)
                }
                if (next === 'edit') requireEditing({ op: 'edit', id: noteId }, turn)
                else turn()
              }}
            >
              <Icon name={mode === 'edit' ? 'mode.preview' : 'mode.edit'} size="lg" />
            </button>
          </div>
        </header>
      )}
      {suggestFailure && (
        <PhoneDetailSheet
          title={t('phone.note.suggest')}
          body={aiSuggestFailure(suggestFailure)}
          onClose={() => setSuggestFailure(undefined)}
        />
      )}
      {sheet === 'notebook' && (
        <NotebookPicker
          books={store.books}
          current={note.bookId}
          onClose={() => setSheet(null)}
          onPick={(bookId) => {
            setSheet(null)
            touched(note.id)
            watchWrite('move', core.setBook(note.id, bookId))
          }}
        />
      )}
      {sheet === 'status' && (
        <StatusPicker
          current={note.status}
          onClose={() => setSheet(null)}
          onPick={(status) => {
            setSheet(null)
            touched(note.id)
            watchWrite('status', core.setStatus(note.id, status))
          }}
        />
      )}
      {sheet === 'tags' && (
        <TagPicker
          note={note}
          tags={store.tags}
          counts={tagCounts(store.notes)}
          onClose={() => setSheet(null)}
          onCreate={(name, color) => {
            touched(note.id)
            watchWrite(
              'tags',
              core
                .addTag(note.id, name)
                .then((id) => {
                  rememberTag(globalThis.localStorage, id)
                  return color ? core.setTagColor(id, color) : undefined
                })
                .then(store.refresh),
            )
          }}
          onToggle={(tag, on) => {
            touched(note.id)
            watchWrite(
              'tags',
              (on ? core.addTag(note.id, tag.name) : core.removeTag(note.id, tag.id)).then(
                store.refresh,
              ),
            )
          }}
        />
      )}
    </section>
  )
}
