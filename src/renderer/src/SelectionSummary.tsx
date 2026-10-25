import { useMemo } from 'react'
import type { NoteStatus, NoteSummary, TagRecord } from '../../core'
import { countOf } from './format'
import { useHeadlines, type HeadlineLoader } from './headlines'
import { currentLocale, format, t } from './i18n'
import { StatusPicker } from './StatusPicker'
import { TagEditor } from './TagEditor'

const SHOWN_TITLES = 8

/**
 * The editor pane while several notes are selected: how many, their titles,
 * and what can be done to all of them at once. In the library: move, pin or
 * unpin, status, tags, copy links, move to the Trash; in Templates the same
 * without status and tags (a template's own are not used); in the Trash:
 * restore or delete permanently.
 */
export function SelectionSummary(props: {
  notes: readonly NoteSummary[]
  view: 'notes' | 'templates' | 'trash'
  tags: readonly TagRecord[]
  headlines?: HeadlineLoader | undefined
  onMove: () => void
  onPin: (pinned: boolean) => void
  onStatus: (status: NoteStatus) => void
  onAddTag: (name: string) => void
  onRemoveTag: (tagId: string) => void
  onCopyLinks: () => void
  onTrash: () => void
  onRestore: () => void
  onDelete: () => void
  /** Only Copy Links works: the trial is over without a licence. */
  readOnly?: boolean
}) {
  const { notes, view, readOnly } = props
  const locale = currentLocale()
  const pinned = notes.every((n) => n.pinned)
  const status = notes[0]?.status ?? 'none'
  const mixed = notes.some((n) => n.status !== status)
  const tagIds = [...new Set(notes.flatMap((n) => n.tagIds))]
  const common = tagIds.filter((id) => notes.every((n) => n.tagIds.includes(id)))
  const more = notes.length - SHOWN_TITLES
  const listed = useMemo(() => notes.slice(0, SHOWN_TITLES), [notes])
  const headlines = useHeadlines(props.headlines, listed)
  return (
    <section className="selection-summary" aria-label={t('selection.label')}>
      <h2 className="selection-count">
        {countOf(notes.length, locale, 'selection.countOne', 'selection.countOther')}
      </h2>
      <ul className="selection-titles">
        {listed.map((n) => (
          <li key={n.id}>{n.title || headlines.get(n.id) || t('note.untitled')}</li>
        ))}
      </ul>
      {more > 0 ? (
        <p className="selection-more">
          {format(t('selection.more'), { count: new Intl.NumberFormat(locale).format(more) })}
        </p>
      ) : null}
      {view === 'trash' ? (
        <div className="selection-actions">
          <button type="button" className="button" disabled={readOnly} onClick={props.onRestore}>
            {t('trash.restore')}
          </button>
          <button
            type="button"
            className="button button-destructive"
            disabled={readOnly}
            onClick={props.onDelete}
          >
            {t('trash.deleteForever')}
          </button>
        </div>
      ) : (
        <>
          <div className="selection-actions">
            <button type="button" className="button" disabled={readOnly} onClick={props.onMove}>
              {t('noteMenu.move')}
            </button>
            <button
              type="button"
              className="button"
              disabled={readOnly}
              onClick={() => props.onPin(!pinned)}
            >
              {t(pinned ? 'note.unpin' : 'note.pin')}
            </button>
            <button type="button" className="button" onClick={props.onCopyLinks}>
              {t('batch.copyLinks')}
            </button>
            <button type="button" className="button" disabled={readOnly} onClick={props.onTrash}>
              {t('note.moveToTrash')}
            </button>
          </div>
          {view === 'notes' ? (
            <div className="note-meta selection-meta" inert={readOnly}>
              <StatusPicker value={status} mixed={mixed} onChange={props.onStatus} />
              <span className="meta-divider" aria-hidden="true" />
              <TagEditor
                tags={props.tags}
                value={tagIds}
                common={common}
                onAdd={props.onAddTag}
                onRemove={props.onRemoveTag}
              />
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}
