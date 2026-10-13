import { useId, useState } from 'react'
import type { TagColor, TagRecord } from '../../core/storage'
import { MAX_TAG_NAME_CHARS } from '../../core/tags'
import { trimWhitespace } from '../../core/text'
import { format, t } from './i18n'
import { Icon } from './icons/Icon'
import { isImeKey } from './ime'
import { useNameLimit } from './nameLimit'

/** A tag's colour: a dot painted with the theme's token for it, named for assistive tech. */
export function TagDot(props: { color: TagColor }) {
  return (
    <span
      className={`tag-dot tag-color-${props.color}`}
      data-color={props.color}
      role="img"
      aria-label={t(`tagColor.${props.color}`)}
    />
  )
}

/**
 * The open note's tags as chips, with a field to add one (existing tags are
 * suggested). For several notes, `value` is every tag any of them has and
 * `common` those all of them have: the others are still suggested, and
 * Backspace in the empty field takes nothing off.
 */
export function TagEditor(props: {
  tags: readonly TagRecord[]
  value: readonly string[]
  common?: readonly string[]
  onAdd: (name: string) => void
  onRemove: (tagId: string) => void
}) {
  const several = props.common !== undefined
  const full = props.common ?? props.value
  const [draft, setDraft] = useState('')
  const suggestions = useId()
  const onNote = props.tags.filter((tag) => props.value.includes(tag.id))
  const limit = useNameLimit(draft, MAX_TAG_NAME_CHARS, setDraft)
  const add = () => {
    if (!trimWhitespace(draft)) return
    props.onAdd(draft)
    setDraft('')
  }
  return (
    <div className="tag-editor" role="group" aria-label={t('note.tagsLabel')}>
      {onNote.map((tag) => (
        <span key={tag.id} className="chip">
          {tag.color ? <TagDot color={tag.color} /> : null}
          {tag.name}
          <button
            type="button"
            className="chip-remove"
            aria-label={format(t('note.removeTagNamed'), { name: tag.name })}
            onClick={() => props.onRemove(tag.id)}
          >
            <Icon name="tag.remove" size="sm" />
          </button>
        </span>
      ))}
      <input
        className="tag-input"
        aria-label={t('note.addTag')}
        placeholder={t('note.addTag')}
        list={suggestions}
        value={draft}
        {...limit}
        onKeyDown={(e) => {
          // Keys an input method composes with (picking a candidate) are its own.
          if (isImeKey(e.nativeEvent)) return
          if (e.key === 'Enter') {
            e.preventDefault()
            add()
          }
          const last = onNote.at(-1)
          if (e.key === 'Backspace' && draft === '' && last && !several) props.onRemove(last.id)
        }}
      />
      <datalist id={suggestions}>
        {props.tags
          .filter((tag) => !full.includes(tag.id))
          .map((tag) => (
            <option key={tag.id} value={tag.name} />
          ))}
      </datalist>
    </div>
  )
}
