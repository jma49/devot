import { useMemo, useState, type ReactNode } from 'react'
import { countMatches, savedSearchQuery } from '../../../core/savedSearches'
import { tagColorClass, tagColorStyle } from '../tagColorStyle'
import { BookIcon } from '../BookIcon'
import { noteDate } from '../format'
import { currentLocale, format, t } from '../i18n'
import { Icon } from '../icons/Icon'
import { libraryOf, type PhoneStatusFilter, type PhoneView } from './library'
import { SectionHead } from './PhoneNoteList'
import type { PhoneData } from './usePhoneData'

function GroupedRow(props: {
  name: string
  count?: number
  icon: ReactNode
  depth?: number
  strong?: boolean
  onOpen: () => void
  disclosure?: { open: boolean; onToggle: () => void }
}) {
  return (
    <li
      className="phone-grouped-row"
      data-child={props.depth ? true : undefined}
      style={props.depth ? { ['--phone-row-depth' as string]: props.depth - 1 } : undefined}
    >
      {props.depth ? <span aria-hidden="true" className="phone-row-guide" /> : null}
      <button type="button" className="phone-grouped-open" onClick={props.onOpen}>
        <span className="phone-row-icon">{props.icon}</span>
        <span className="phone-grouped-label" data-strong={props.strong || undefined}>
          {props.name}
        </span>
        {props.count !== undefined && (
          <span className="phone-grouped-count phone-figures">{props.count}</span>
        )}
        {!props.disclosure && (
          <span className="phone-chevron">
            <Icon name="phone.disclosure" size="sm" weight="medium" />
          </span>
        )}
      </button>
      {props.disclosure && (
        <button
          type="button"
          className="phone-disclosure"
          aria-expanded={props.disclosure.open}
          aria-label={format(
            t(props.disclosure.open ? 'phone.library.collapse' : 'phone.library.expand'),
            {
              name: props.name,
            },
          )}
          onClick={props.disclosure.onToggle}
        >
          <Icon
            name={props.disclosure.open ? 'disclosure.open' : 'phone.disclosure'}
            size="sm"
            weight="medium"
          />
        </button>
      )}
    </li>
  )
}

function Group(props: {
  title: string
  collapsed: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <section className="phone-section" aria-label={props.title}>
      <SectionHead title={props.title} collapsed={props.collapsed} onToggle={props.onToggle} />
      <div
        className="phone-note-section-body phone-section-body"
        data-collapsed={props.collapsed || undefined}
        inert={props.collapsed}
      >
        <ul className="phone-card">{props.children}</ul>
      </div>
    </section>
  )
}

export function PhoneLibrary(props: {
  data: PhoneData
  onShowNotes: (view: PhoneView, status: PhoneStatusFilter) => void
  onOpenList: (view: PhoneView) => void
  onNewNotebook: () => void
  onSearch: () => void
  onSavedSearch: (query: string) => void
}) {
  const { data } = props
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const [collapsed, setCollapsed] = useState({ books: false, searches: false, tags: false })
  const library = useMemo(
    () => libraryOf(data.notes, data.books, data.tags, open, navigator.languages),
    [data.notes, data.books, data.tags, open],
  )
  const searches = useMemo(
    () =>
      data.savedSearches.map((search) => ({
        search,
        count: countMatches(
          data.notes,
          savedSearchQuery(search, { books: data.books, tags: data.tags }),
        ),
      })),
    [data.savedSearches, data.notes, data.books, data.tags],
  )
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })

  const backup =
    data.lastBackup === undefined
      ? null
      : data.lastBackup === null
        ? t('sidebar.notBackedUp')
        : format(t('phone.library.backedUpAt'), {
            time: noteDate(data.lastBackup, data.loadedAt, currentLocale()),
          })
  const notesCount = format(t('phone.library.noteCount'), { count: String(library.counts.all) })

  return (
    <section aria-label={t('phone.tab.library')} className="phone-screen">
      <div className="phone-scroll phone-library">
        <ul className="phone-card" aria-label={t('phone.library.smart')}>
          <GroupedRow
            name={t('sidebar.allNotes')}
            count={library.counts.all}
            icon={<Icon name="phone.all" size="phone-row" />}
            onOpen={() => props.onShowNotes({ kind: 'all' }, 'all')}
          />
          <GroupedRow
            name={t('sidebar.pinned')}
            count={library.counts.pinned}
            icon={<Icon name="notes.pinned" size="phone-row" />}
            onOpen={() => props.onShowNotes({ kind: 'pinned' }, 'all')}
          />
          <GroupedRow
            name={t('status.active')}
            count={library.counts.active}
            icon={<Icon name="phone.status.active" size="phone-row" />}
            onOpen={() => props.onShowNotes({ kind: 'all' }, 'active')}
          />
          <GroupedRow
            name={t('status.completed')}
            count={library.counts.completed}
            icon={<Icon name="phone.completed" size="phone-row" />}
            onOpen={() => props.onShowNotes({ kind: 'all' }, 'completed')}
          />
        </ul>

        {searches.length > 0 && (
          <Group
            title={t('phone.library.savedSearches')}
            collapsed={collapsed.searches}
            onToggle={() => setCollapsed((c) => ({ ...c, searches: !c.searches }))}
          >
            {searches.map(({ search, count }) => (
              <GroupedRow
                key={search.id}
                name={search.name}
                {...(count === null ? {} : { count })}
                icon={<Icon name="search" size="phone-row" />}
                onOpen={() => props.onSavedSearch(search.query)}
              />
            ))}
          </Group>
        )}

        {library.books.length > 0 && (
          <Group
            title={t('sidebar.notebooks')}
            collapsed={collapsed.books}
            onToggle={() => setCollapsed((c) => ({ ...c, books: !c.books }))}
          >
            {library.books.map((row) => (
              <GroupedRow
                key={row.id}
                name={row.name}
                count={row.count}
                depth={row.depth}
                strong={row.open}
                icon={<BookIcon icon={row.icon} color={null} size="phone-row" />}
                onOpen={() => props.onOpenList({ kind: 'book', id: row.id })}
                {...(row.hasChildren
                  ? { disclosure: { open: row.open, onToggle: () => toggle(row.id) } }
                  : {})}
              />
            ))}
          </Group>
        )}

        {library.tags.length > 0 && (
          <Group
            title={t('sidebar.tags')}
            collapsed={collapsed.tags}
            onToggle={() => setCollapsed((c) => ({ ...c, tags: !c.tags }))}
          >
            {library.tags.map((row) => (
              <GroupedRow
                key={row.id}
                name={row.name}
                count={row.count}
                icon={
                  <span
                    aria-hidden="true"
                    className={`phone-tag-dot ${tagColorClass(row.color)}`}
                    style={tagColorStyle(row.color)}
                  />
                }
                onOpen={() => props.onOpenList({ kind: 'tag', id: row.id })}
              />
            ))}
          </Group>
        )}

        <ul className="phone-card">
          <GroupedRow
            name={t('sidebar.templates')}
            count={data.templates.length}
            icon={<Icon name="templates" size="phone-row" />}
            onOpen={() => props.onOpenList({ kind: 'templates' })}
          />
          <GroupedRow
            name={t('sidebar.trash')}
            count={data.trash.length}
            icon={<Icon name="trash" size="phone-row" />}
            onOpen={() => props.onOpenList({ kind: 'trash' })}
          />
        </ul>

        <p className="phone-library-footer phone-figures">
          {backup ? `${notesCount} · ${backup}` : notesCount}
        </p>
      </div>
      <div aria-hidden="true" className="phone-topbar-band" />
      <header className="phone-topbar">
        <h1 className="phone-topbar-title">{t('phone.tab.library')}</h1>
        <div className="phone-glass phone-capsule">
          <button
            type="button"
            className="phone-capsule-button"
            aria-label={t('book.new')}
            onClick={props.onNewNotebook}
          >
            <Icon name="phone.notebook.new" size="lg" />
          </button>
          <button
            type="button"
            className="phone-capsule-button"
            aria-label={t('search.placeholder')}
            onClick={props.onSearch}
          >
            <Icon name="search" size="lg" />
          </button>
        </div>
      </header>
    </section>
  )
}
