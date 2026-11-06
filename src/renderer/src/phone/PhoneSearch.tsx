import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { errorCode } from '../../../core/errors'
import { TEMPLATES_BOOK_ID } from '../../../core/books'
import {
  bookQuery,
  highlightTerms,
  parseSearch,
  searchPattern,
  tagQuery,
} from '../../../core/search'
import type { NoteStatus, NoteSummary, TagColor, TagColorValue } from '../../../core/storage'
import { tagColorClass, tagColorStyle } from '../tagColorStyle'
import { displayTitle } from '../headlines'
import { format, t } from '../i18n'
import { Icon } from '../icons/Icon'
import { compareNames } from '../../../core/sort'
import { NoteRow, useExcerpts } from './PhoneNoteList'
import { STATUS_LABEL, statusMark } from './pickers'
import { excerptNearMatch, readRecentSearches, rememberSearch } from './search'
import { localStore } from '../localStore'
import { useKeyboard } from './useKeyboard'
import type { PhoneStore } from './usePhoneData'

const SEARCH_DELAY_MS = 120
const STATUS_CHIPS: readonly NoteStatus[] = ['active', 'on_hold', 'completed']

const dotColor = (color: TagColor | null) =>
  color ? `var(--color-tag-${color})` : 'var(--color-phone-status-none)'

function Chip(props: {
  label: string
  dot?: string
  ink?: string
  clock?: boolean
  tagColor?: TagColorValue | null
  onPick: () => void
}) {
  return (
    <button type="button" className="phone-search-chip" onClick={props.onPick}>
      <span
        className={`phone-search-chip-face ${tagColorClass(props.tagColor)}`}
        style={{ ...tagColorStyle(props.tagColor), ...(props.ink ? { color: props.ink } : {}) }}
      >
        {props.clock && (
          <span className="phone-search-chip-clock">
            <Icon name="phone.clock" size="xs" weight="medium" />
          </span>
        )}
        {props.dot && (
          <span
            aria-hidden="true"
            className="phone-search-chip-dot"
            style={{ background: props.dot }}
          />
        )}
        {props.label}
      </span>
    </button>
  )
}

function ChipGroup(props: { title: string; children: ReactNode }) {
  return (
    <section className="phone-search-group" aria-label={props.title}>
      <h2 className="phone-search-group-title">{props.title}</h2>
      <div className="phone-search-chips">{props.children}</div>
    </section>
  )
}

export function PhoneSearch(props: {
  store: PhoneStore
  open: boolean
  /** A saved search's query, run on open without raising the keyboard. */
  query?: string | undefined
  onClose: () => void
  onOpenNote: (id: string) => void
}) {
  const { store } = props
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{
    query: string
    found: readonly NoteSummary[]
    capped: boolean
  } | null>(null)
  const [recent, setRecent] = useState<readonly string[]>([])
  const input = useRef<HTMLInputElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const keyboard = useKeyboard()
  const wanted = query.trim()

  const [shownOpen, setShownOpen] = useState(props.open)
  if (shownOpen !== props.open) {
    setShownOpen(props.open)
    if (props.open) {
      setQuery(props.query ?? '')
      setResults(null)
      setRecent(readRecentSearches(localStore()))
    }
  }

  // In the tap's own task: iOS raises the keyboard only for a focus a tap caused.
  useLayoutEffect(() => {
    if (props.open) {
      opener.current = document.activeElement as HTMLElement | null
      if (!props.query) input.current?.focus()
      return
    }
    input.current?.blur()
    opener.current?.focus({ preventScroll: true })
    opener.current = null
  }, [props.open, props.query])

  useEffect(() => {
    const core = store.core
    if (!props.open || !core || wanted === '') return
    let alive = true
    const timer = setTimeout(() => {
      core
        .search(wanted)
        .then(({ found, capped }) => {
          if (alive) setResults({ query: wanted, found, capped })
        })
        .catch((e: unknown) => console.warn('W_PHONE_SEARCH_FAILED', errorCode(e)))
    }, SEARCH_DELAY_MS)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [store.core, props.open, wanted])

  const shown = wanted === '' ? null : results
  const rows = useMemo(() => shown?.found ?? [], [shown])
  const patterns = useMemo(() => {
    const terms = highlightTerms(parseSearch(shown?.query ?? ''), store.tags)
    return {
      title: searchPattern(terms.title),
      body: searchPattern(terms.body),
    }
  }, [shown?.query, store.tags])
  const listExcerpts = useExcerpts(store, rows)
  const bookName = useMemo(() => new Map(store.books.map((b) => [b.id, b.name])), [store.books])
  const notebooks = store.books.filter((b) => b.deletedAt === null && b.id !== TEMPLATES_BOOK_ID)
  const tags = store.tags
    .filter((tag) => tag.deletedAt === null)
    .sort((a, b) => compareNames(a.name, b.name, navigator.languages))

  const remember = () => setRecent(rememberSearch(localStore(), query))
  const fill = (next: string) => {
    setQuery(next)
    input.current?.focus()
  }

  return (
    <div
      className="phone-search"
      role="dialog"
      aria-modal="true"
      aria-label={t('search.label')}
      data-open={props.open || undefined}
      inert={!props.open}
      style={{ ['--phone-search-keyboard' as string]: `${keyboard.height}px` }}
    >
      <div className="phone-scroll phone-search-scroll">
        {wanted === '' && (
          <div className="phone-search-idle">
            {recent.length > 0 && (
              <ChipGroup title={t('phone.search.recent')}>
                {recent.map((q) => (
                  <Chip key={q} label={q} clock onPick={() => fill(q)} />
                ))}
              </ChipGroup>
            )}
            {notebooks.length > 0 && (
              <ChipGroup title={t('sidebar.notebooks')}>
                {notebooks.map((book) => (
                  <Chip
                    key={book.id}
                    label={book.name}
                    dot={dotColor(book.iconColor)}
                    onPick={() => fill(`${bookQuery(book)} `)}
                  />
                ))}
              </ChipGroup>
            )}
            <ChipGroup title={t('sidebar.statuses')}>
              {STATUS_CHIPS.map((status) => (
                <Chip
                  key={status}
                  label={t(STATUS_LABEL[status])}
                  dot={statusMark(status)}
                  onPick={() => fill(`is:${status} `)}
                />
              ))}
            </ChipGroup>
            {tags.length > 0 && (
              <ChipGroup title={t('sidebar.tags')}>
                {tags.map((tag) => (
                  <Chip
                    key={tag.id}
                    label={`#${tag.name}`}
                    dot="var(--tag-color, var(--color-phone-status-none))"
                    tagColor={tag.color}
                    {...(tag.color ? { ink: 'var(--tag-text)' } : {})}
                    onPick={() => fill(`${tagQuery(tag)} `)}
                  />
                ))}
              </ChipGroup>
            )}
          </div>
        )}
        {shown && rows.length > 0 && (
          <section aria-label={t('phone.tab.notes')}>
            <h2 className="phone-search-head">
              <span className="phone-list-head-name">{t('phone.tab.notes')}</span>
              <span className="phone-list-head-count phone-figures">
                {shown.capped ? `${rows.length}+` : rows.length}
              </span>
              <span aria-hidden="true" className="phone-list-head-rule" />
            </h2>
            <ul className="phone-note-list">
              {rows.map((note) => {
                const excerpt = note.excerpt ?? listExcerpts.get(note.id) ?? ''
                return (
                  <NoteRow
                    key={note.id}
                    note={note}
                    title={displayTitle(note.title, excerpt.split('\n')[0])}
                    excerpt={excerptNearMatch(excerpt, patterns.body)}
                    titlePattern={patterns.title}
                    excerptPattern={patterns.body}
                    meta={note.bookId === null ? '' : (bookName.get(note.bookId) ?? '')}
                    tag={undefined}
                    now={store.loadedAt}
                    open={false}
                    swipes={false}
                    arrived={false}
                    onOpenChange={() => {}}
                    closeOthers={() => false}
                    onOpen={() => {
                      remember()
                      props.onOpenNote(note.id)
                    }}
                    onPeek={() => {}}
                    onAction={() => {}}
                  />
                )
              })}
            </ul>
          </section>
        )}
        {shown && rows.length === 0 && shown.query === wanted && (
          <div className="phone-search-empty">
            <span className="phone-search-empty-icon">
              <Icon name="search" size="phone-tab" />
            </span>
            <p className="phone-search-empty-title">
              {format(t('phone.search.none'), { query: shown.query })}
            </p>
            <p className="phone-search-empty-hint">{t('phone.search.hint')}</p>
          </div>
        )}
      </div>
      <div aria-hidden="true" className="phone-topbar-band" />
      <header className="phone-topbar">
        <label className="phone-glass phone-search-field">
          <span className="phone-search-field-icon">
            <Icon name="search" size="phone-row" />
          </span>
          <span className="phone-visually-hidden">{t('search.label')}</span>
          <input
            ref={input}
            className="phone-search-input"
            value={query}
            placeholder={t('phone.search.placeholder')}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') props.onClose()
              if (event.key === 'Enter') {
                remember()
                input.current?.blur()
              }
            }}
          />
          {query !== '' && (
            <button
              type="button"
              className="phone-search-clear"
              aria-label={t('search.clear')}
              onClick={() => fill('')}
            >
              <span className="phone-search-clear-face">
                <Icon name="phone.close" size="xs" weight="bold" />
              </span>
            </button>
          )}
        </label>
        <button
          type="button"
          className="phone-glass phone-nav-control"
          aria-label={t('phone.search.close')}
          onClick={props.onClose}
        >
          <Icon name="phone.close" size="phone-row" />
        </button>
      </header>
    </div>
  )
}
