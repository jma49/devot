import { fieldStep } from './Picker'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { BookRecord, NoteSummary, TemplateDraft } from '../../core'
import { headline } from '../../core/extract'
import type { Core } from './core-client'
import { displayTitle, useHeadlines, type HeadlineLoader } from './headlines'
import { format, t } from './i18n'
import { isImeKey } from './ime'
import { starterTemplates } from './starterTemplates'
import { templateGroups } from './templates'

const optionId = (i: number) => `template-option-${i}`

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
  headlines?: HeadlineLoader | undefined
  recent: readonly string[]
  books: readonly BookRecord[]
  /** The notebook a note goes to when its template names none. */
  bookId: string | null
  locales: readonly string[]
  /** The pick fills the open (empty) note instead of making a new one. */
  intoOpenNote?: boolean | undefined
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
    return () => el?.close()
  }, [])

  const groups = useMemo(
    () => templateGroups(props.templates, props.recent, query, props.locales),
    [props.templates, props.recent, query, props.locales],
  )
  const builtIn = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return starterTemplates().filter((s) => !needle || s.title.toLocaleLowerCase().includes(needle))
  }, [query])
  const options: { id: string; title: string }[] = [...groups.recent, ...groups.others, ...builtIn]
  const index = Math.min(active, options.length - 1)
  const current = options[index]
  const currentId = current?.id

  useEffect(() => {
    document.getElementById(optionId(index))?.scrollIntoView({ block: 'nearest' })
  }, [index])

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
    if (isImeKey(e.nativeEvent)) return
    const next = fieldStep(e.key, index, options.length)
    if (next !== undefined) {
      e.preventDefault()
      if (next >= 0) setActive(next)
    } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault()
      pick()
    }
  }

  const row = (template: { id: string; title: string }, i: number) => (
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
        {t(props.intoOpenNote ? 'templates.chooseTitle' : 'templates.pickTitle')}
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
                {grouped || builtIn.length > 0 ? (
                  <div className="pick-group" aria-hidden="true">
                    {t('sidebar.templates')}
                  </div>
                ) : null}
                {groups.others.map((template, i) => row(template, groups.recent.length + i))}
              </div>
            ) : null}
            {builtIn.length > 0 ? (
              <div role="group" aria-label={t('templates.builtIn')}>
                <div className="pick-group" aria-hidden="true">
                  {t('templates.builtIn')}
                </div>
                {builtIn.map((template, i) =>
                  row(template, groups.recent.length + groups.others.length + i),
                )}
              </div>
            ) : null}
          </div>
          {options.length === 0 ? <p className="sheet-detail">{t('templates.noMatches')}</p> : null}
        </div>
        <section className="templates-preview" aria-label={t('templates.preview')} tabIndex={0}>
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
          {t(props.intoOpenNote ? 'templates.use' : 'templates.create')}
        </button>
      </div>
    </dialog>
  )
}
