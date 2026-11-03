import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { MAX_SAVED_SEARCH_NAME_CHARS, MAX_SAVED_SEARCH_QUERY_CHARS } from '../../core/savedSearches'
import { trimWhitespace } from '../../core/text'
import { t } from './i18n'
import { isImeKey } from './ime'
import { useNameLimit } from './nameLimit'

/** Save Search (a new row) or Edit Saved Search: a name and the query it runs. */
export function SavedSearchDialog(props: {
  editing: boolean
  name: string
  query: string
  onSave: (change: { name: string; query: string }) => void
  onCancel: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState(props.name)
  const [query, setQuery] = useState(props.query)
  const nameLimit = useNameLimit(name, MAX_SAVED_SEARCH_NAME_CHARS, setName)
  const queryLimit = useNameLimit(query, MAX_SAVED_SEARCH_QUERY_CHARS, setQuery)
  useLayoutEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
    return () => el?.close()
  }, [])

  const cleanName = trimWhitespace(name)
  const cleanQuery = trimWhitespace(query)
  const ready = cleanName !== '' && cleanQuery !== ''
  const save = () => {
    if (ready) props.onSave({ name: cleanName, query: cleanQuery })
  }
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isImeKey(e.nativeEvent) || e.key !== 'Enter') return
    e.preventDefault()
    save()
  }
  const field = {
    className: 'pick-filter',
    type: 'text',
    autoComplete: 'off',
    autoCorrect: 'off',
    autoCapitalize: 'off',
    spellCheck: false,
    onKeyDown: onEnter,
  } as const

  return (
    <dialog
      ref={dialog}
      className="sheet saved-search-dialog"
      aria-labelledby="saved-search-title"
      onCancel={(e) => {
        e.preventDefault()
        props.onCancel()
      }}
    >
      <h2 id="saved-search-title" className="sheet-title">
        {t(props.editing ? 'savedSearch.editTitle' : 'savedSearch.title')}
      </h2>
      <label className="sheet-field">
        <span className="sheet-detail">{t('savedSearch.nameLabel')}</span>
        <input
          {...field}
          aria-label={t('savedSearch.nameLabel')}
          autoFocus
          value={name}
          {...nameLimit}
        />
      </label>
      <label className="sheet-field">
        <span className="sheet-detail">{t('savedSearch.queryLabel')}</span>
        <input
          {...field}
          aria-label={t('savedSearch.queryLabel')}
          dir="auto"
          value={query}
          {...queryLimit}
        />
      </label>
      <div className="confirm-actions">
        <button type="button" className="button" onClick={props.onCancel}>
          {t('dialog.cancel')}
        </button>
        <button type="button" className="button button-default" disabled={!ready} onClick={save}>
          {t('dialog.save')}
        </button>
      </div>
    </dialog>
  )
}
