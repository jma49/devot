import { fieldStep } from './Picker'
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

export interface TagPick {
  tagId: string | null
  name: string
}

/** The tags a typed name lists: those it holds, and those the core counts as the same name. */
export function matchingTags(tags: readonly TagRecord[], typed: string): TagRecord[] {
  const needle = typed.toLocaleLowerCase()
  return tags.filter(
    (tag) => !needle || sameName(tag.name, typed) || tag.name.toLocaleLowerCase().includes(needle),
  )
}

export function TagPickDialog(props: {
  mode: 'add' | 'remove'
  tags: readonly TagRecord[]
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
    return () => el?.close()
  }, [])

  // The filter is a new tag's name too: it stops at a tag name's limit.
  const limit = useNameLimit(query, MAX_TAG_NAME_CHARS, (next) => {
    setQuery(next)
    setActive(0)
  })
  const typed = trimWhitespace(query)
  const found: TagPick[] = matchingTags(props.tags, typed).map((tag) => ({
    tagId: tag.id,
    name: tag.name,
  }))
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
    const next = fieldStep(e.key, index, options.length)
    if (next !== undefined) {
      e.preventDefault()
      if (next >= 0) setActive(next)
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
