import { useMemo, useState, type ReactNode } from 'react'
import type { TagColor } from '../../../core/storage'
import { BookIcon } from '../BookIcon'
import { noteDate } from '../format'
import { currentLocale, format, t, type MessageKey } from '../i18n'
import { Icon } from '../icons/Icon'
import type { IconName } from '../icons/symbols'
import { libraryOf, type PhoneStatusFilter, type PhoneView } from './library'
import type { PhoneData } from './usePhoneData'

const tileColor = (color: TagColor | null) =>
  color ? `var(--color-tag-${color})` : 'var(--color-phone-status-none)'

function SmartTile(props: {
  label: MessageKey
  icon: IconName
  count: number
  color: string
  onOpen: () => void
}) {
  return (
    <button type="button" className="phone-smart-tile" onClick={props.onOpen}>
      <span className="phone-smart-tile-icon" style={{ background: props.color }}>
        <Icon name={props.icon} size="sm" />
      </span>
      <span className="phone-smart-tile-count phone-figures">{props.count}</span>
      <span className="phone-smart-tile-label">{t(props.label)}</span>
    </button>
  )
}

function GroupedRow(props: {
  name: string
  count?: number
  tile: ReactNode
  tileColor: string
  child?: boolean
  strong?: boolean
  onOpen: () => void
  disclosure?: { open: boolean; onToggle: () => void }
}) {
  return (
    <li className="phone-grouped-row" data-child={props.child || undefined}>
      <button type="button" className="phone-grouped-open" onClick={props.onOpen}>
        <span className="phone-row-tile" style={{ background: props.tileColor }}>
          {props.tile}
        </span>
        <span className="phone-grouped-label" data-strong={props.strong || undefined}>
          {props.name}
        </span>
        {props.count !== undefined && (
          <span className="phone-grouped-count phone-figures">{props.count}</span>
        )}
        {!props.disclosure && (
          <span className="phone-chevron">
            <Icon name="phone.disclosure" size="xs" />
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
          <Icon name={props.disclosure.open ? 'disclosure.open' : 'phone.disclosure'} size="xs" />
        </button>
      )}
    </li>
  )
}

function Section(props: { title?: string; children: ReactNode }) {
  return (
    <section className="phone-section" aria-label={props.title}>
      {props.title && <h2 className="phone-section-head">{props.title}</h2>}
      <ul className="phone-card">{props.children}</ul>
    </section>
  )
}

export function PhoneLibrary(props: {
  data: PhoneData
  onShowNotes: (view: PhoneView, status: PhoneStatusFilter) => void
  onOpenList: (view: PhoneView) => void
  onNewNotebook: () => void
}) {
  const { data } = props
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const library = useMemo(
    () => libraryOf(data.notes, data.books, data.tags, open, navigator.languages),
    [data.notes, data.books, data.tags, open],
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
  const notesCount = format(t('phone.library.noteCount'), { count: String(library.tiles.all) })

  return (
    <section aria-label={t('phone.tab.library')} className="phone-screen">
      <div className="phone-scroll phone-library">
        <div className="phone-smart-tiles">
          <SmartTile
            label="sidebar.allNotes"
            icon="phone.tile.all"
            count={library.tiles.all}
            color="var(--color-accent-fill)"
            onOpen={() => props.onShowNotes({ kind: 'all' }, 'all')}
          />
          <SmartTile
            label="sidebar.pinned"
            icon="notes.pinned"
            count={library.tiles.pinned}
            color="var(--color-phone-action-pin)"
            onOpen={() => props.onShowNotes({ kind: 'pinned' }, 'all')}
          />
          <SmartTile
            label="status.active"
            icon="phone.tile.active"
            count={library.tiles.active}
            color="var(--color-status-active-mark)"
            onOpen={() => props.onShowNotes({ kind: 'all' }, 'active')}
          />
          <SmartTile
            label="phone.library.done"
            icon="check"
            count={library.tiles.done}
            color="var(--color-phone-action-done)"
            onOpen={() => props.onShowNotes({ kind: 'all' }, 'completed')}
          />
        </div>

        {library.books.length > 0 && (
          <Section title={t('sidebar.notebooks')}>
            {library.books.map((row) => (
              <GroupedRow
                key={row.id}
                name={row.name}
                count={row.count}
                child={row.depth > 0}
                strong={row.open}
                tileColor={tileColor(row.color)}
                tile={<BookIcon icon={row.icon} color={null} size="sm" />}
                onOpen={() => props.onOpenList({ kind: 'book', id: row.id })}
                {...(row.hasChildren
                  ? { disclosure: { open: row.open, onToggle: () => toggle(row.id) } }
                  : {})}
              />
            ))}
          </Section>
        )}

        {library.tags.length > 0 && (
          <Section title={t('sidebar.tags')}>
            {library.tags.map((row) => (
              <GroupedRow
                key={row.id}
                name={row.name}
                count={row.count}
                tileColor={tileColor(row.color)}
                tile={<Icon name="phone.tag" size="sm" />}
                onOpen={() => props.onOpenList({ kind: 'tag', id: row.id })}
              />
            ))}
          </Section>
        )}

        <Section>
          <GroupedRow
            name={t('sidebar.templates')}
            count={data.templates.length}
            tileColor="var(--color-phone-status-none)"
            tile={<Icon name="templates" size="sm" />}
            onOpen={() => props.onOpenList({ kind: 'templates' })}
          />
          <GroupedRow
            name={t('sidebar.trash')}
            count={data.trash.length}
            tileColor="var(--color-phone-status-none)"
            tile={<Icon name="trash" size="sm" />}
            onOpen={() => props.onOpenList({ kind: 'trash' })}
          />
        </Section>

        <p className="phone-library-footer">{backup ? `${notesCount} · ${backup}` : notesCount}</p>
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
            onClick={() => props.onShowNotes({ kind: 'all' }, 'all')}
          >
            <Icon name="search" size="lg" />
          </button>
        </div>
      </header>
    </section>
  )
}
