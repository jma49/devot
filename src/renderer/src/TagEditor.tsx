import { useId, useRef, useState, type RefObject } from 'react'
import type { TagColor, TagRecord } from '../../core/storage'
import { MAX_TAG_NAME_CHARS } from '../../core/tags'
import { trimWhitespace } from '../../core/text'
import { closingRef } from './closing'
import type { MenuPoint } from './contextMenu'
import { format, t } from './i18n'
import { Icon } from './icons/Icon'
import { isImeKey } from './ime'
import { fieldStep } from './Picker'
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

/** A tag chip's classes: a coloured tag's chip takes its tag colour (app.css `.tag-chip`). */
export const chipClass = (color: TagColor | null | undefined) =>
  color ? `chip tag-chip tag-color-${color}` : 'chip'

/** A row of the tag field's suggestions: an existing tag, or a new one to make. */
export type TagRow = { kind: 'tag'; tag: TagRecord } | { kind: 'create'; name: string }

/** Suggestions shown at most. */
const MAX_SUGGESTIONS = 8
/** The suggestions shrink back toward the field as they close. */
const suggestionsRef = closingRef('scale', 'tag-suggestions')

/**
 * What the tag field suggests for `draft`: the tags not in `exclude` whose
 * names hold it (those that start with it first), then a last row that
 * makes a tag of the text, unless a tag of that name exists. Nothing while
 * the field is empty.
 */
export function tagRows(
  tags: readonly TagRecord[],
  exclude: readonly string[],
  draft: string,
): TagRow[] {
  const text = trimWhitespace(draft)
  if (!text) return []
  const want = text.toLocaleLowerCase()
  const found = tags
    .filter((tag) => !exclude.includes(tag.id) && tag.name.toLocaleLowerCase().includes(want))
    .sort(
      (a, b) =>
        Number(!a.name.toLocaleLowerCase().startsWith(want)) -
          Number(!b.name.toLocaleLowerCase().startsWith(want)) || a.name.localeCompare(b.name),
    )
    .slice(0, MAX_SUGGESTIONS)
  const rows: TagRow[] = found.map((tag) => ({ kind: 'tag', tag }))
  const exists = tags.some((tag) => tag.name.toLocaleLowerCase() === want)
  if (!exists) rows.push({ kind: 'create', name: text })
  return rows
}

/**
 * The open note's tags as chips, with a field to add one. Typing lists the
 * tags that match and a last row that makes a new one; Up and Down move
 * through them, Return picks one (the text itself when none is chosen),
 * Escape cancels. Backspace or Left in the empty field selects the last
 * chip, and Backspace takes a selected chip off. For several notes, `value`
 * is every tag any of them has and `common` those all of them have: the
 * others are still suggested, and no chip is selected or taken off from
 * the field.
 */
export function TagEditor(props: {
  tags: readonly TagRecord[]
  value: readonly string[]
  common?: readonly string[]
  onAdd: (name: string) => void
  onRemove: (tagId: string) => void
  /** Right-click on a chip: the chip menu, at the pointer. */
  onChipMenu?: (tagId: string, at: MenuPoint) => void
  /** The field, for the title's Return to go on to. */
  inputRef?: RefObject<HTMLInputElement | null>
}) {
  const several = props.common !== undefined
  const full = props.common ?? props.value
  const [draft, setDraft] = useState('')
  // The suggestion Up and Down moved to (-1: none), whether the suggestions
  // show, and the chip Backspace or Left selected.
  const [active, setActive] = useState(-1)
  const [open, setOpen] = useState(false)
  const [chosenChip, setChosenChip] = useState<string>()
  const ownField = useRef<HTMLInputElement>(null)
  const field = props.inputRef ?? ownField
  const listId = useId()
  const onNote = props.tags.filter((tag) => props.value.includes(tag.id))
  const rows = open ? tagRows(props.tags, full, draft) : []
  const changeDraft = (next: string) => {
    setDraft(next)
    setActive(-1)
    setOpen(true)
    setChosenChip(undefined)
  }
  const limit = useNameLimit(draft, MAX_TAG_NAME_CHARS, changeDraft)
  const close = () => {
    setDraft('')
    setActive(-1)
    setOpen(false)
  }
  const pick = (row: TagRow | undefined) => {
    const name = row ? (row.kind === 'tag' ? row.tag.name : row.name) : draft
    if (!trimWhitespace(name)) return
    props.onAdd(name)
    close()
  }
  const optionId = (i: number) => `${listId}-${i}`
  return (
    <div className="tag-editor" role="group" aria-label={t('note.tagsLabel')}>
      {onNote.map((tag) => (
        <span
          key={tag.id}
          className={chipClass(tag.color)}
          data-selected={chosenChip === tag.id || undefined}
          onContextMenu={
            props.onChipMenu
              ? (e) => {
                  e.preventDefault()
                  props.onChipMenu?.(tag.id, { x: e.clientX, y: e.clientY })
                }
              : undefined
          }
        >
          {tag.color ? <TagDot color={tag.color} /> : null}
          {tag.name}
          <button
            type="button"
            className="chip-remove"
            aria-label={format(t('note.removeTagNamed'), { name: tag.name })}
            onClick={(e) => {
              props.onRemove(tag.id)
              // The chip goes away with the keyboard on it: the tag field takes it.
              if (e.detail === 0) field.current?.focus()
            }}
          >
            <Icon name="tag.remove" size="xs" />
          </button>
        </span>
      ))}
      <span className="tag-field">
        <input
          ref={field}
          className="tag-input"
          role="combobox"
          aria-label={t('note.addTag')}
          aria-expanded={rows.length > 0}
          aria-controls={rows.length > 0 ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 && rows[active] ? optionId(active) : undefined}
          placeholder={t('note.addTags')}
          value={draft}
          {...limit}
          onBlur={() => {
            setOpen(false)
            setActive(-1)
            setChosenChip(undefined)
          }}
          onKeyDown={(e) => {
            // Keys an input method composes with (picking a candidate) are its own.
            if (isImeKey(e.nativeEvent)) return
            if (e.metaKey || e.ctrlKey || e.altKey) return
            if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && draft !== '') {
              e.preventDefault()
              const shown = tagRows(props.tags, full, draft)
              if (!open) setOpen(true)
              if (shown.length === 0) return
              const key = e.key
              setActive((i) => fieldStep(key, i, shown.length) ?? i)
              return
            }
            if (e.key === 'Enter') {
              e.preventDefault()
              return pick(rows[active])
            }
            if (e.key === 'Escape' && (draft !== '' || chosenChip !== undefined)) {
              e.preventDefault()
              e.stopPropagation()
              setChosenChip(undefined)
              return close()
            }
            if (draft !== '' || several || onNote.length === 0) return
            const at =
              chosenChip === undefined ? -1 : onNote.findIndex((tag) => tag.id === chosenChip)
            if (e.key === 'Backspace') {
              e.preventDefault()
              const chosen = onNote[at]
              if (chosen) {
                setChosenChip(undefined)
                return props.onRemove(chosen.id)
              }
              return setChosenChip(onNote.at(-1)?.id)
            }
            if (e.key === 'ArrowLeft') {
              e.preventDefault()
              return setChosenChip(onNote[at < 0 ? onNote.length - 1 : Math.max(0, at - 1)]?.id)
            }
            if (e.key === 'ArrowRight' && at >= 0) {
              e.preventDefault()
              return setChosenChip(onNote[at + 1]?.id)
            }
          }}
        />
        {rows.length > 0 ? (
          <ul
            ref={suggestionsRef}
            id={listId}
            className="tag-suggestions"
            role="listbox"
            aria-label={t('note.tagSuggestions')}
          >
            {rows.map((row, i) => (
              <li
                key={row.kind === 'tag' ? row.tag.id : 'create'}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                className={row.kind === 'create' ? 'tag-suggestion tag-create' : 'tag-suggestion'}
                // The field keeps the keyboard.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(row)}
              >
                {row.kind === 'tag' ? (
                  <>
                    {row.tag.color ? <TagDot color={row.tag.color} /> : null}
                    {row.tag.name}
                  </>
                ) : (
                  format(t('note.createTag'), { name: row.name })
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </span>
    </div>
  )
}
