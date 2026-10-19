import { fieldStep } from './Picker'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { BookNode } from '../../core/books'
import { bookOptions, currentBookOption, filterBooks, NO_BOOK } from './BookPicker'
import { format, t } from './i18n'
import { Icon } from './icons/Icon'
import { BookIcon } from './BookIcon'
import { isImeKey } from './ime'

const optionId = (i: number) => `move-note-option-${i}`

export function MoveNoteDialog(props: {
  tree: BookNode[]
  title: string
  /**
   * The note's notebook now; null for none, undefined when it is in none of
   * the options (a template), so that every option, No Notebook too, moves it.
   */
  value: string | null | undefined
  detail?: string | undefined
  onMove: (bookId: string | null) => void
  onCancel: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  useLayoutEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
    return () => el?.close()
  }, [])

  const all = [
    {
      id: NO_BOOK,
      name: t('note.noBook'),
      depth: 0,
      ancestors: [],
      icon: null,
      iconColor: null,
    },
    ...bookOptions(props.tree),
  ]
  const needle = query.trim().toLocaleLowerCase()
  // The notebooks a name is nested in stay, so equal names can be told apart.
  const matches = needle ? filterBooks(all, query) : all
  const current = props.value === undefined ? undefined : currentBookOption(all, props.value)
  const index = Math.min(active, matches.length - 1)

  useEffect(() => {
    document.getElementById(optionId(index))?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const pick = (id: string) => {
    if (id === current) return props.onCancel()
    props.onMove(id === NO_BOOK ? null : id)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isImeKey(e.nativeEvent)) return
    const next = fieldStep(e.key, index, matches.length)
    if (next !== undefined) {
      e.preventDefault()
      if (next >= 0) setActive(next)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const chosen = matches[index]
      if (chosen) pick(chosen.id)
    }
  }

  return (
    <dialog
      ref={dialog}
      className="sheet move-note"
      aria-labelledby="move-note-title"
      aria-describedby="move-note-detail"
      onCancel={(e) => {
        e.preventDefault()
        props.onCancel()
      }}
    >
      <h2 id="move-note-title" className="sheet-title">
        {t('moveNote.title')}
      </h2>
      <p id="move-note-detail" className="sheet-detail">
        {props.detail ?? format(t('moveNote.detail'), { title: props.title })}
      </p>
      <input
        className="pick-filter"
        type="text"
        role="combobox"
        aria-label={t('moveNote.filter')}
        placeholder={t('moveNote.filter')}
        aria-expanded="true"
        aria-controls="move-note-options"
        aria-autocomplete="list"
        aria-activedescendant={index >= 0 ? optionId(index) : undefined}
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
      <ul
        id="move-note-options"
        className="pick-list"
        role="listbox"
        aria-label={t('sidebar.notebooks')}
      >
        {matches.map((o, i) => (
          <li
            key={o.id || 'none'}
            id={optionId(i)}
            className="pick-row"
            role="option"
            aria-selected={i === index}
            aria-checked={o.id === current}
            style={{ paddingInlineStart: `calc(var(--space-4) + ${o.depth} * var(--space-7))` }}
            onMouseMove={() => setActive(i)}
            onClick={() => pick(o.id)}
          >
            {o.id === NO_BOOK ? (
              // An empty icon slot, so its name lines up with the notebooks'.
              <span className="picker-icon-slot" aria-hidden="true" />
            ) : (
              <BookIcon icon={o.icon} color={o.iconColor} size="sm" />
            )}
            <span className="pick-name">{o.name}</span>
            {o.id === current ? <Icon name="check" size="sm" /> : null}
          </li>
        ))}
      </ul>
      {matches.length === 0 ? <p className="sheet-detail">{t('moveNote.noMatches')}</p> : null}
      <div className="confirm-actions">
        <button type="button" className="button" onClick={props.onCancel}>
          {t('dialog.cancel')}
        </button>
      </div>
    </dialog>
  )
}
