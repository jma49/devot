import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { BookRecord, NoteSummary, TemplateDraft } from '../../core'
import { headline } from '../../core/extract'
import type { Core } from './core-client'
import { displayTitle, useHeadlines, type HeadlineLoader } from './headlines'
import { format, t } from './i18n'
import { isImeKey } from './ime'
import { templateGroups } from './templates'

const optionId = (i: number) => `template-option-${i}`

/** What the picker previews: the note a template makes, and its notebook. */
type Draft = TemplateDraft & { bookId: string | null }

/**
 * Picks a template to make a note from (New Note from Template, Cmd+T):
 * recently used templates first, then the rest by title; type to filter,
 * arrow keys or a click to select, Return, a double click or Create to make
 * the note, Escape to cancel. The selected template is previewed as the
 * note it would make now: its title, the notebook, tags and status its
 * front matter sets, and its Markdown with the variables filled in.
 */
export function TemplatePicker(props: {
  core: Core
  templates: readonly NoteSummary[]
  /** Looks up the first line of a template with no title, which names it. */
  headlines?: HeadlineLoader | undefined
  /** Template IDs used last on this device, newest first. */
  recent: readonly string[]
  books: readonly BookRecord[]
  /** The notebook a note goes to when its template names none. */
  bookId: string | null
  locales: readonly string[]
  onCreate: (templateId: string) => void
  onCancel: () => void
}) {
  const { core, bookId } = props
  const headlines = useHeadlines(props.headlines, props.templates)
  const dialog = useRef<HTMLDialogElement>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [draft, setDraft] = useState<{ id: string; draft: Draft | null }>()
  useLayoutEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
    // Closing (rather than only removing) the dialog gives the keyboard back.
    return () => el?.close()
  }, [])

  const groups = useMemo(
    () => templateGroups(props.templates, props.recent, query, props.locales),
    [props.templates, props.recent, query, props.locales],
  )
  const options = [...groups.recent, ...groups.others]
  const index = Math.min(active, options.length - 1)
  const current = options[index]
  const currentId = current?.id

  useEffect(() => {
    document.getElementById(optionId(index))?.scrollIntoView({ block: 'nearest' })
  }, [index])

  // The preview of the selected template, as of now.
  useEffect(() => {
    if (currentId === undefined) return
    let alive = true
    core.templateDraft(currentId, Date.now(), bookId).then(
      (next) => alive && setDraft({ id: currentId, draft: next }),
      () => alive && setDraft({ id: currentId, draft: null }),
    )
    return () => {
      alive = false
    }
  }, [core, currentId, bookId])
  const shown = draft && draft.id === currentId ? draft.draft : undefined

  const pick = () => {
    if (current) props.onCreate(current.id)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Keys that pick or confirm an input method's candidate are not ours.
    if (isImeKey(e.nativeEvent)) return
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    if (step) {
      e.preventDefault()
      setActive(Math.max(0, Math.min(options.length - 1, index + step)))
    } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault()
      pick()
    }
  }

  const row = (template: NoteSummary, i: number) => (
    <div
      key={template.id}
      id={optionId(i)}
      className="pick-row"
      role="option"
      aria-selected={i === index}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => setActive(i)}
      onDoubleClick={() => props.onCreate(template.id)}
    >
      <span className="pick-name">{displayTitle(template.title, headlines.get(template.id))}</span>
    </div>
  )
  const grouped = groups.recent.length > 0
  const bookName = (id: string | null) => props.books.find((b) => b.id === id)?.name

  return (
    <dialog
      ref={dialog}
      className="sheet templates"
      aria-labelledby="templates-title"
      onCancel={(e) => {
        e.preventDefault()
        props.onCancel()
      }}
    >
      <h2 id="templates-title" className="sheet-title">
        {t('templates.pickTitle')}
      </h2>
      <div className="templates-body">
        <div className="templates-pick">
          <input
            className="pick-filter"
            type="text"
            role="combobox"
            aria-label={t('templates.filter')}
            placeholder={t('templates.filter')}
            aria-expanded="true"
            aria-controls="template-options"
            aria-autocomplete="list"
            aria-activedescendant={current ? optionId(index) : undefined}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
          />
          <div
            id="template-options"
            className="pick-list templates-list"
            role="listbox"
            aria-label={t('sidebar.templates')}
          >
            {grouped ? (
              <div role="group" aria-label={t('templates.recent')}>
                <div className="pick-group" aria-hidden="true">
                  {t('templates.recent')}
                </div>
                {groups.recent.map((template, i) => row(template, i))}
              </div>
            ) : null}
            {groups.others.length > 0 ? (
              <div role="group" aria-label={t('sidebar.templates')}>
                {grouped ? (
                  <div className="pick-group" aria-hidden="true">
                    {t('sidebar.templates')}
                  </div>
                ) : null}
                {groups.others.map((template, i) => row(template, groups.recent.length + i))}
              </div>
            ) : null}
          </div>
          {props.templates.length === 0 ? (
            <p className="sheet-detail">{t('templates.none')}</p>
          ) : options.length === 0 ? (
            <p className="sheet-detail">{t('templates.noMatches')}</p>
          ) : null}
        </div>
        <section className="templates-preview" aria-label={t('templates.preview')}>
          {shown ? (
            <>
              <h3 className="templates-preview-title">
                {displayTitle(shown.title, headline(shown.body))}
              </h3>
              <p className="templates-preview-meta">
                {bookName(shown.bookId) !== undefined ? (
                  <span>{format(t('templates.notebook'), { name: bookName(shown.bookId)! })}</span>
                ) : null}
                {shown.tags.length > 0 ? (
                  <span>{format(t('templates.tags'), { tags: shown.tags.join(', ') })}</span>
                ) : null}
                {shown.status !== null && shown.status !== 'none' ? (
                  <span>
                    {format(t('templates.status'), { status: t(`status.${shown.status}`) })}
                  </span>
                ) : null}
              </p>
              <pre className="templates-preview-body">{shown.body}</pre>
            </>
          ) : null}
        </section>
      </div>
      <div className="confirm-actions">
        <button type="button" className="button" onClick={props.onCancel}>
          {t('dialog.cancel')}
        </button>
        <button type="button" className="button button-default" disabled={!current} onClick={pick}>
          {t('templates.create')}
        </button>
      </div>
    </dialog>
  )
}
