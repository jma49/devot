import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { TagRecord } from '../../core/storage'
import { MAX_TAG_NAME_CHARS, sameName } from '../../core/tags'
import { trimWhitespace } from '../../core/text'
import { noteCount } from './format'
import { currentLocale, format, t } from './i18n'
import { isImeKey } from './ime'
import { useNameLimit } from './nameLimit'
import { TagDot } from './TagEditor'

const optionId = (i: number) => `tag-pick-option-${i}`

/** A tag picked: an existing one, or (adding) a new name. */
export interface TagPick {
  tagId: string | null
  name: string
}

/**
 * Picks a tag to add to or remove from several notes: type to filter, arrow
 * keys and Return (or a click) to pick, Escape to cancel. Adding, a name no
 * tag has yet is offered as a new tag.
 */
export function TagPickDialog(props: {
  mode: 'add' | 'remove'
  /** The tags to offer: every tag (adding), or those on the notes (removing). */
  tags: readonly TagRecord[]
  /** How many notes the tag goes on or comes off. */
  count: number
  onPick: (pick: TagPick) => void
  onCancel: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  useLayoutEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
    // Closing (rather than only removing) the dialog gives the keyboard back.
    return () => el?.close()
  }, [])

  // The filter is a new tag's name too: it stops at a tag name's limit.
  const limit = useNameLimit(query, MAX_TAG_NAME_CHARS, (next) => {
    setQuery(next)
    setActive(0)
  })
  const typed = trimWhitespace(query)
  const needle = typed.toLocaleLowerCase()
  const found: TagPick[] = props.tags
    .filter((tag) => !needle || tag.name.toLocaleLowerCase().includes(needle))
    .map((tag) => ({ tagId: tag.id, name: tag.name }))
  const fresh =
    props.mode === 'add' && typed !== '' && !props.tags.some((tag) => sameName(tag.name, typed))
  const options: TagPick[] = fresh ? [{ tagId: null, name: typed }, ...found] : found
  const index = Math.min(active, options.length - 1)
  const colors = new Map(props.tags.map((tag) => [tag.id, tag.color]))

  useEffect(() => {
    document.getElementById(optionId(index))?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Keys that end an input method's composition are left to it.
    if (isImeKey(e.nativeEvent)) return
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    if (step) {
      e.preventDefault()
      setActive(Math.max(0, Math.min(options.length - 1, index + step)))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const chosen = options[index]
      if (chosen) props.onPick(chosen)
    }
  }

  const notes = noteCount(props.count, currentLocale())
  const adding = props.mode === 'add'
  return (
    <dialog
      ref={dialog}
      className="sheet move-note"
      aria-labelledby="tag-pick-title"
      aria-describedby="tag-pick-detail"
      onCancel={(e) => {
        e.preventDefault()
        props.onCancel()
      }}
    >
      <h2 id="tag-pick-title" className="sheet-title">
        {t(adding ? 'tagPick.addTitle' : 'tagPick.removeTitle')}
      </h2>
      <p id="tag-pick-detail" className="sheet-detail">
        {format(t(adding ? 'tagPick.addDetail' : 'tagPick.removeDetail'), { notes })}
      </p>
      <input
        className="pick-filter"
        type="text"
        role="combobox"
        aria-label={t('tagPick.filter')}
        placeholder={t('tagPick.filter')}
        aria-expanded="true"
        aria-controls="tag-pick-options"
        aria-autocomplete="list"
        aria-activedescendant={index >= 0 ? optionId(index) : undefined}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        autoFocus
        value={query}
        {...limit}
        onKeyDown={onKeyDown}
      />
      <ul id="tag-pick-options" className="pick-list" role="listbox" aria-label={t('sidebar.tags')}>
        {options.map((o, i) => {
          const color = o.tagId === null ? null : colors.get(o.tagId)
          return (
            <li
              key={o.tagId ?? 'new'}
              id={optionId(i)}
              className="pick-row"
              role="option"
              aria-selected={i === index}
              onMouseMove={() => setActive(i)}
              onClick={() => props.onPick(o)}
            >
              {color ? <TagDot color={color} /> : null}
              <span className="pick-name">
                {o.tagId === null ? format(t('tagPick.create'), { name: o.name }) : o.name}
              </span>
            </li>
          )
        })}
      </ul>
      {options.length === 0 ? <p className="sheet-detail">{t('tagPick.noMatches')}</p> : null}
      <div className="confirm-actions">
        <button type="button" className="button" onClick={props.onCancel}>
          {t('dialog.cancel')}
        </button>
      </div>
    </dialog>
  )
}
