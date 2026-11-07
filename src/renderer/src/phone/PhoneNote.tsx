import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { createAiGenerator } from '../../../core/aiProvider'
import { createSuggester } from '../../../core/aiSuggest'
import type { NoteSummary } from '../../../core/storage'
import { noteCounts } from '../../../core/noteCounts'
import { tagCounts } from '../../../core/tags'
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
import type { IconName } from '../icons/symbols'
import type { LinkSources } from '../linkCompletion'
import { linkedNoteCreate, linkedNoteDiscard } from '../linkedNotes'
import type { EarlyKey } from '../editor/earlyKeys'
import type { EditorHandle } from '../editor/handle'
import { motionReduced } from '../motionPreference'
import { motionMs } from '../motionTiming'
import { NoteEditor } from '../NoteEditor'
import { listDevices, useSyncSnapshot } from '../sync'
import type { FindTarget } from '../find/target'
import { Preview } from '../preview/Preview'
import type { FormatId } from '../editor/formats'
import { notebookPath } from './library'
import { useNoteStats, type NoteStats } from './noteStats'
import { PhoneFindBar } from './PhoneFindBar'
import {
  NotebookPicker,
  STATUS_LABEL,
  StatusMark,
  StatusPicker,
  statusTile,
  TagPicker,
} from './pickers'
import { PhoneDetailSheet, PhoneSheet, SheetChoice } from './PhoneSheet'
import { requireEditing, watchWrite } from './requireEditing'
import type { PhoneStore } from './usePhoneData'
import { useKeyboard } from './useKeyboard'

const FORMATS: readonly {
  id: FormatId
  icon: IconName
  label:
    | 'format.heading'
    | 'format.bold'
    | 'format.italic'
    | 'format.taskList'
    | 'format.code'
    | 'format.link'
}[] = [
  { id: 'heading', icon: 'format.heading', label: 'format.heading' },
  { id: 'bold', icon: 'format.bold', label: 'format.bold' },
  { id: 'italic', icon: 'format.italic', label: 'format.italic' },
  { id: 'taskList', icon: 'format.taskList', label: 'format.taskList' },
  { id: 'code', icon: 'format.code', label: 'format.code' },
  { id: 'link', icon: 'format.link', label: 'format.link' },
]

const rowIcon = (name: IconName) => (
  <span className="phone-row-icon">
    <Icon name={name} size="phone-row" />
  </span>
)

function InfoSheet(props: {
  store: PhoneStore
  note: NoteSummary
  stats: NoteStats
  onClose: () => void
  onTrash: () => void
  onOpenNote: (id: string) => void
}) {
  const { store, note } = props
  const sync = useSyncSnapshot()
  const [revisions, setRevisions] = useState<number | null>(null)
  const [backlinks, setBacklinks] = useState<readonly NoteSummary[] | null>(null)
  const [devices, setDevices] = useState<number | null>(null)
  const [linksOpen, setLinksOpen] = useState(false)
  useEffect(() => {
    const core = store.core
    if (!core) return
    let alive = true
    void Promise.all([core.history(note.id), core.backlinks(note.id)])
      .then(([history, links]) => {
        if (!alive) return
        setRevisions(history.length)
        setBacklinks(links)
      })
      .catch(() => console.warn('W_PHONE_INFO_FAILED'))
    return () => {
      alive = false
    }
  }, [store.core, note.id])
  useEffect(() => {
    if (!sync.enrolled) return
    let alive = true
    void listDevices()
      .then((found) => alive && setDevices(found.length))
      .catch(() => console.warn('W_PHONE_DEVICES_FAILED'))
    return () => {
      alive = false
    }
  }, [sync.enrolled])
  const { stats } = props
  const book = store.books.find((b) => b.id === note.bookId)
  const when = (at: number) => noteDate(at, store.loadedAt, currentLocale())
  const strip: readonly [string, string][] = [
    [t('phone.info.words'), stats.words.toLocaleString(currentLocale())],
    [t('phone.info.characters'), stats.characters.toLocaleString(currentLocale())],
    [
      t('phone.info.reading'),
      format(t('phone.info.minutes'), { count: String(stats.readingMinutes) }),
    ],
    [t('phone.info.revisions'), revisions === null ? '' : String(revisions)],
  ]
  return (
    <PhoneSheet title={t('phone.info.title')} onClose={props.onClose} tall>
      <dl className="phone-card phone-info-stats">
        {strip.map(([label, value]) => (
          <div key={label} className="phone-info-stat">
            <dd className="phone-figures">{value}</dd>
            <dt>{label}</dt>
          </div>
        ))}
      </dl>
      <ul className="phone-card">
        <SheetChoice
          lead={rowIcon('notebook')}
          label={t('phone.info.notebook')}
          value={book?.name ?? t('phone.noNotebook')}
        />
        <SheetChoice
          lead={rowIcon('phone.calendar')}
          label={t('phone.info.created')}
          value={when(note.createdAt)}
          figures
        />
        <SheetChoice
          lead={rowIcon('phone.clock')}
          label={t('phone.info.modified')}
          value={when(note.updatedAt)}
          figures
        />
        {devices !== null && (
          <SheetChoice
            lead={rowIcon('phone.devices')}
            label={t('phone.info.devices')}
            value={String(devices)}
            figures
          />
        )}
      </ul>
      {backlinks !== null && (
        <ul className="phone-card">
          <SheetChoice
            lead={rowIcon('phone.link')}
            label={t('phone.info.backlinks')}
            value={String(backlinks.length)}
            figures
            {...(backlinks.length > 0 ? { onPick: () => setLinksOpen((open) => !open) } : {})}
          />
          {linksOpen &&
            backlinks.map((link) => (
              <SheetChoice
                key={link.id}
                label={link.title || t('note.untitled')}
                onPick={() => props.onOpenNote(link.id)}
              />
            ))}
        </ul>
      )}
      <ul className="phone-card">
        <SheetChoice label={t('note.moveToTrash')} destructive onPick={props.onTrash} />
      </ul>
    </PhoneSheet>
  )
}

type Sheet = 'info' | 'notebook' | 'status' | 'tags' | null

const PICKER_OPS = { notebook: 'move', status: 'status', tags: 'tags' } as const

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

// A push that ends without a transitionend (the layer was already in place) still lands.
const LANDING_MARGIN_MS = 100

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
  onTrash: (note: NoteSummary) => void
  arrival?: NewNoteArrival
}) {
  const { store, arrival } = props
  const screen = useRef<HTMLElement>(null)
  const landed = useLanded(screen, arrival !== undefined)
  const [loadedId, setLoadedId] = useState<string | null>(null)
  const touched = (id: string) => {
    if (id === props.noteId) arrival?.onTouched()
  }
  const [history, setHistory] = useState({ ids: [props.noteId], at: 0 })
  const noteId = history.ids[history.at]!
  const note =
    store.notes.find((n) => n.id === noteId) ?? store.templates.find((n) => n.id === noteId)
  const [modes, setModes] = useState<Readonly<Record<string, 'edit' | 'preview'>>>({})
  const editing = useEditing()
  const setMode = (next: 'edit' | 'preview') => setModes((m) => ({ ...m, [noteId]: next }))
  const [toggles, setToggles] = useState(0)
  const [body, setBody] = useState({ id: noteId, text: '' })
  const text = body.id === noteId ? body.text : ''
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
  const [findTarget, setFindTarget] = useState<FindTarget | null>(null)
  // A locked note stays in Preview; only Find shows its editor, which then takes no caret.
  const mode = editing || finding ? (modes[noteId] ?? 'preview') : 'preview'
  const titleField = useRef<HTMLTextAreaElement>(null)
  const editor = useRef<EditorHandle | null>(null)
  const showAlertMenu = useAlertMenu()
  const keyboard = useKeyboard()
  // The keyboard rises during a new note's push: the screen makes room for it once the push lands.
  const typing = mode === 'edit' && keyboard.open && !finding && landed
  // An editor being left reports an empty body as it goes: only its own note's body takes that.
  const showText = (id: string, next: string) => {
    if (next !== '') touched(id)
    setBody((shown) => (shown.id === id ? { id, text: next } : shown))
  }
  const noteLoaded = (id: string, loaded: string) => {
    setLoadedId(id)
    setBody({ id, text: loaded })
    // An empty note has nothing to read, so it opens ready to write.
    setModes((m) => (m[id] ? m : { ...m, [id]: loaded === '' ? 'edit' : 'preview' }))
  }

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

  const openNote = (id: string) =>
    setHistory((h) => ({ ids: [...h.ids.slice(0, h.at + 1), id], at: h.at + 1 }))
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
      </section>
    )

  const core = store.core
  const book = store.books.find((b) => b.id === note.bookId)
  const crumb = notebookPath(store.books, note.bookId)
  const tags = note.tagIds
    .map((id) => store.tags.find((tag) => tag.id === id))
    .filter((tag) => tag !== undefined && tag.deletedAt === null)
  const title = titleDraft ?? note.title
  const back = () => (history.at > 0 ? setHistory((h) => ({ ...h, at: h.at - 1 })) : props.onBack())
  const pick = (picker: 'notebook' | 'status' | 'tags') =>
    requireEditing({ op: PICKER_OPS[picker], id: note.id }, () => setSheet(picker))

  return (
    <section ref={screen} aria-label={note.title || t('note.untitled')} className="phone-screen">
      <div className="phone-scroll phone-note-scroll">
        <div className="phone-note-heading-field" data-title={title}>
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
          <div className="phone-note-layer" data-shown={mode === 'edit' || undefined}>
            <NoteEditor
              key={noteId}
              core={core}
              noteId={noteId}
              autoFocus={false}
              hidden={mode === 'preview'}
              readOnly={!editing}
              noKeyboard
              onText={(read) => showText(noteId, read())}
              onLoaded={(loaded) => noteLoaded(noteId, loaded)}
              links={links}
              showAlertMenu={showAlertMenu}
              handleRef={editor}
              onOpenNote={openNote}
              onFind={setFindTarget}
              suggester={suggester}
              onSuggestFailed={setSuggestFailure}
            />
          </div>
          <div
            className="phone-note-layer phone-note-preview"
            data-shown={mode === 'preview' || undefined}
            aria-hidden={mode !== 'preview'}
          >
            {mode === 'preview' && (
              <Preview
                core={core}
                markdown={text}
                onOpenNote={openNote}
                onToggleTask={(at) =>
                  requireEditing({ op: 'task', id: noteId }, () => editor.current?.toggleTask(at))
                }
              />
            )}
          </div>
        </div>
      </div>
      <div aria-hidden="true" className="phone-topbar-band" />
      <header className="phone-topbar">
        <button
          type="button"
          className="phone-glass phone-nav-control"
          aria-label={t('phone.back')}
          onClick={props.onBack}
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
          <span aria-hidden="true" className="phone-capsule-divider" />
          <button
            type="button"
            className="phone-capsule-button"
            aria-label={t('phone.info.title')}
            onClick={() => setSheet('info')}
          >
            <Icon name="phone.info" size="lg" />
          </button>
        </div>
      </header>
      <div
        className="phone-note-bottom"
        data-hidden={typing || finding || undefined}
        inert={typing || finding}
      >
        <div className="phone-glass phone-capsule phone-capsule-tall">
          <button
            type="button"
            className="phone-capsule-button"
            aria-label={t('phone.note.previous')}
            onClick={back}
          >
            <Icon name="phone.history.back" size="md" />
          </button>
          <button
            type="button"
            className="phone-capsule-button"
            aria-label={t('phone.note.next')}
            disabled={history.at >= history.ids.length - 1}
            onClick={() => setHistory((h) => ({ ...h, at: h.at + 1 }))}
          >
            <Icon name="phone.history.forward" size="md" />
          </button>
        </div>
        <span className="phone-topbar-spacer" />
        <button
          type="button"
          className="phone-glass phone-note-circle"
          aria-label={t('phone.note.find')}
          onClick={() => {
            setMode('edit')
            setFinding(true)
          }}
        >
          <Icon name="search" size="md" />
        </button>
        {mode === 'edit' && (
          <button
            type="button"
            className="phone-glass phone-note-circle phone-note-ai"
            aria-label={t('phone.note.suggest')}
            onClick={() =>
              requireEditing({ op: 'ai', id: noteId }, () => editor.current?.suggest())
            }
          >
            <Icon name="format.ai" size="md" />
          </button>
        )}
      </div>
      <div
        className="phone-accessory"
        data-shown={typing || undefined}
        inert={!typing}
        style={{ bottom: `calc(${keyboard.height}px + var(--size-phone-sheet-inset))` }}
      >
        <div
          role="toolbar"
          aria-label={t('phone.note.formatting')}
          className="phone-glass phone-accessory-bar"
        >
          {FORMATS.map((f) => (
            <button
              key={f.id}
              type="button"
              className="phone-accessory-button"
              aria-label={t(f.label)}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => editor.current?.format(f.id)}
            >
              <Icon name={f.icon} size="md" />
            </button>
          ))}
          <button
            type="button"
            className="phone-accessory-button phone-accessory-ai"
            aria-label={t('phone.note.accept')}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => editor.current?.acceptSuggestion()}
          >
            <Icon name="format.ai" size="md" />
          </button>
        </div>
        <button
          type="button"
          className="phone-glass phone-accessory-hide"
          aria-label={t('phone.note.hideKeyboard')}
          onClick={() => (document.activeElement as HTMLElement | null)?.blur()}
        >
          <Icon name="phone.keyboard.hide" size="md" />
        </button>
      </div>
      {suggestFailure && (
        <PhoneDetailSheet
          title={t('phone.note.suggest')}
          body={aiSuggestFailure(suggestFailure)}
          onClose={() => setSuggestFailure(undefined)}
        />
      )}
      {finding && (
        <PhoneFindBar
          target={findTarget}
          keyboardHeight={keyboard.height}
          onClose={() => setFinding(false)}
        />
      )}
      {sheet === 'info' && (
        <InfoSheet
          store={store}
          note={note}
          stats={stats}
          onClose={() => setSheet(null)}
          onTrash={() => {
            setSheet(null)
            requireEditing({ op: 'trash', id: note.id }, () => {
              touched(note.id)
              props.onTrash(note)
              props.onBack()
            })
          }}
          onOpenNote={(id) => {
            setSheet(null)
            openNote(id)
          }}
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
