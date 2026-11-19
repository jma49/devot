import {
  forwardRef,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type Ref,
} from 'react'
import type { BookRecord, TagRecord } from '../../core/storage'
import type { MenuPoint } from './contextMenu'
import { format, t, type MessageKey } from './i18n'
import { Icon } from './icons/Icon'
import type { IconName } from './icons/symbols'
import { isImeKey } from './ime'
import { fieldStep, usePickerOpen } from './Picker'
import {
  applySearchSuggestion,
  backspaceSearchPill,
  composeSearchValue,
  removeSearchPill,
  searchSuggestions,
  splitSearchPills,
  type SearchPill,
  type SearchSuggestion,
} from './searchPills'
import { tagColorStyle } from './tagColorStyle'
import { TagDot } from './TagDot'

const SYNTAX = [
  { example: 'word  "a phrase"  \'a phrase\'', note: 'search.help.text' },
  { example: 'title:  body:', note: 'search.help.part' },
  { example: 'book:Name  in:Name', note: 'search.help.book' },
  { example: 'tag:Name  #Name', note: 'search.help.tag' },
  { example: 'status:Name  is:Name', note: 'search.help.status' },
  { example: 'bookId:ID  tagId:ID', note: 'search.help.ids' },
  { example: 'pinned:true  pinned:false', note: 'search.help.pinned' },
  { example: '-word  -book:  -tag:  -status:  -pinned:', note: 'search.help.exclude' },
] as const

function mergeInputRef(
  local: RefObject<HTMLInputElement | null>,
  forwarded: Ref<HTMLInputElement>,
) {
  return (node: HTMLInputElement | null) => {
    local.current = node
    if (typeof forwarded === 'function') forwarded(node)
    else if (forwarded) forwarded.current = node
  }
}

interface ComposingState {
  baseValue: string
  pills: readonly SearchPill[]
  draft: string
}

/**
 * The toolbar search field. Completed filter qualifiers in `value` render as removable pills ahead
 * of the text input while remaining bidirectionally synced with `value`. Typing a filter qualifier
 * opens a keyboard-navigable suggestion popover; Escape dismisses the popover or syntax help
 * before clearing `value`.
 */
export const SearchField = forwardRef<
  HTMLInputElement,
  {
    value: string
    onChange: (query: string) => void
    onClear: () => void
    onOptions?: ((at: MenuPoint) => void) | undefined
    placeholder: string
    icon?: IconName
    books?: readonly BookRecord[] | undefined
    tags?: readonly TagRecord[] | undefined
  }
>(function SearchField(
  { value, onChange, onClear, onOptions, placeholder, icon = 'search', books, tags },
  ref,
) {
  const box = useRef<HTMLDivElement>(null)
  const helpButton = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const pillsRef = useRef<HTMLSpanElement | null>(null)
  const pendingCaret = useRef<number | null>(null)
  const prevPillCount = useRef(0)
  const [helpOpen, setHelpOpen] = usePickerOpen(box)
  const [focused, setFocused] = useState(false)
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  const [composing, setComposing] = useState<ComposingState | null>(null)
  const listId = useId()
  const inputId = useId()

  const split = useMemo(() => splitSearchPills(value, { books, tags }), [value, books, tags])
  // Deriving active composition against `baseValue === value` discards stale preedit on external resets.
  const activeComposition = composing !== null && composing.baseValue === value ? composing : null
  const isComposing = activeComposition !== null
  const pills = activeComposition ? activeComposition.pills : split.pills
  const draft = activeComposition ? activeComposition.draft : split.draft

  useLayoutEffect(() => {
    if (pills.length > prevPillCount.current && pillsRef.current) {
      pillsRef.current.scrollLeft = pillsRef.current.scrollWidth
    }
    prevPillCount.current = pills.length
    if (pendingCaret.current === null || !inputRef.current) return
    const nextAt = Math.min(pendingCaret.current, draft.length)
    pendingCaret.current = null
    inputRef.current.setSelectionRange(nextAt, nextAt)
    setCaret(nextAt)
  }, [pills.length, draft])

  const effectiveCaret = Math.min(caret, draft.length)
  const match = useMemo(
    () =>
      focused && !helpOpen && !isComposing
        ? searchSuggestions(draft, effectiveCaret, { books, tags })
        : { start: 0, end: 0, items: [] },
    [focused, helpOpen, isComposing, draft, effectiveCaret, books, tags],
  )
  const dismissKey = `${draft}\0${effectiveCaret}`
  const openSuggestions = !isComposing && dismissedKey !== dismissKey && match.items.length > 0
  const activeIndex = Math.min(active, Math.max(0, match.items.length - 1))
  const optionId = (i: number) => `${listId}-${i}`

  const acceptSuggestion = (suggestion: SearchSuggestion) => {
    const nextValue = applySearchSuggestion(pills, draft, match, suggestion)
    const nextSplit = splitSearchPills(nextValue, { books, tags })
    setComposing(null)
    setDismissedKey(null)
    setActive(0)
    pendingCaret.current = nextSplit.draft.length
    onChange(nextValue)
    inputRef.current?.focus()
  }

  const removePill = (pill: SearchPill, fromKeyboard: boolean) => {
    const nextValue = removeSearchPill(value, pill)
    setComposing(null)
    setDismissedKey(null)
    onChange(nextValue)
    if (fromKeyboard || focused) inputRef.current?.focus()
  }

  const clearAll = () => {
    setComposing(null)
    setDismissedKey(null)
    setActive(0)
    onClear()
  }

  const pillPrefix = (pill: SearchPill) =>
    `${pill.negate ? '-' : ''}${pill.key}${pill.key === '#' ? '' : ':'}`

  return (
    <div
      ref={box}
      className="search-field-box"
      // Escape closes the syntax list or autocomplete popover before anything clears the search.
      onKeyDownCapture={(e) => {
        if (e.key !== 'Escape' || isImeKey(e.nativeEvent)) return
        if (openSuggestions) {
          e.preventDefault()
          e.stopPropagation()
          setDismissedKey(dismissKey)
          return
        }
        if (!helpOpen) return
        e.preventDefault()
        e.stopPropagation()
        setHelpOpen(false)
        if (!(e.target instanceof HTMLInputElement)) helpButton.current?.focus()
      }}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget)) return
        if (activeComposition !== null) {
          const next = composeSearchValue(activeComposition.pills, activeComposition.draft)
          setComposing(null)
          if (next !== value) onChange(next)
        }
        setFocused(false)
        if (helpOpen) setHelpOpen(false)
      }}
    >
      <label htmlFor={inputId} className="search-field">
        {value || draft ? null : (
          <span className="search-icon">
            <Icon name={icon} size="sm" />
          </span>
        )}
        {pills.length > 0 ? (
          <span
            ref={pillsRef}
            className="search-pills"
            role="list"
            aria-label={t('search.filters')}
          >
            {pills.map((pill) => (
              <span
                key={pill.id}
                role="listitem"
                className="search-pill"
                style={pill.tagColor ? tagColorStyle(pill.tagColor) : undefined}
                dir="auto"
              >
                {pill.tagColor ? <TagDot color={pill.tagColor} name={pill.value} /> : null}
                <span className="search-pill-key">{pillPrefix(pill)}</span>
                <span className="search-pill-label">{pill.value}</span>
                <button
                  type="button"
                  className="search-pill-remove"
                  aria-label={format(t('search.removeFilter'), { filter: pill.raw })}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    removePill(pill, e.detail === 0)
                  }}
                >
                  <Icon name="tag.remove" size="xs" />
                </button>
              </span>
            ))}
          </span>
        ) : null}
        <input
          id={inputId}
          ref={mergeInputRef(inputRef, ref)}
          type="search"
          // Queries are not prose: no autocorrect, capitalisation or spelling marks.
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label={t('search.label')}
          aria-controls={openSuggestions ? listId : undefined}
          aria-activedescendant={openSuggestions ? optionId(activeIndex) : undefined}
          placeholder={pills.length > 0 ? '' : placeholder}
          value={draft}
          onFocus={(e) => {
            setFocused(true)
            setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length)
          }}
          onSelect={(e) => {
            setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length)
          }}
          onCompositionStart={(e) => {
            setComposing({ baseValue: value, pills, draft: e.currentTarget.value })
          }}
          onCompositionEnd={(e) => {
            const fixedPills = activeComposition ? activeComposition.pills : pills
            const committed = e.currentTarget.value
            const nextValue = composeSearchValue(fixedPills, committed)
            const nextSplit = splitSearchPills(nextValue, { books, tags })
            setComposing(null)
            setFocused(true)
            setDismissedKey(null)
            setActive(0)
            if (nextSplit.pills.length > fixedPills.length) {
              pendingCaret.current = nextSplit.draft.length
            } else {
              setCaret(e.currentTarget.selectionStart ?? committed.length)
            }
            onChange(nextValue)
          }}
          onChange={(e) => {
            const nextDraft = e.target.value
            const nextCaret = e.target.selectionStart ?? nextDraft.length
            const eventComposing = (e.nativeEvent as { isComposing?: boolean }).isComposing === true
            setFocused(true)
            setCaret(nextCaret)
            if (activeComposition !== null || eventComposing) {
              const fixedPills = activeComposition ? activeComposition.pills : pills
              setComposing({ baseValue: value, pills: fixedPills, draft: nextDraft })
              return
            }
            setDismissedKey(null)
            setActive(0)
            onChange(composeSearchValue(pills, nextDraft))
          }}
          onKeyDown={(e) => {
            if (isImeKey(e.nativeEvent)) return
            if (openSuggestions) {
              const next = fieldStep(e.key, activeIndex, match.items.length)
              if (next !== undefined) {
                e.preventDefault()
                e.stopPropagation()
                if (next >= 0) setActive(next)
                return
              }
              if (
                (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) ||
                (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey)
              ) {
                const chosen = match.items[activeIndex]
                if (chosen) {
                  e.preventDefault()
                  e.stopPropagation()
                  acceptSuggestion(chosen)
                  return
                }
              }
            }
            if (
              e.key === 'Backspace' &&
              !e.metaKey &&
              !e.ctrlKey &&
              !e.altKey &&
              pills.length > 0 &&
              e.currentTarget.selectionStart === 0 &&
              e.currentTarget.selectionEnd === 0
            ) {
              e.preventDefault()
              const nextValue = backspaceSearchPill(value, pills, draft)
              const nextSplit = splitSearchPills(nextValue, { books, tags })
              pendingCaret.current = draft === '' ? nextSplit.draft.length : 0
              setDismissedKey(null)
              onChange(nextValue)
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              clearAll()
            }
          }}
        />
        {value ? (
          <button
            type="button"
            className="search-clear"
            aria-label={t('search.clear')}
            // Pressing it must not pull focus out of the field.
            onMouseDown={(e) => e.preventDefault()}
            onClick={clearAll}
          >
            <Icon name="tag.remove" size="sm" />
          </button>
        ) : null}
        {value.trim() && onOptions ? (
          <button
            type="button"
            className="search-help-button search-options-button"
            aria-label={t('search.options')}
            title={t('search.options')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              const button = e.currentTarget.getBoundingClientRect()
              onOptions({ x: button.left, y: button.bottom })
            }}
          >
            <Icon name="more.horizontal" size="sm" />
          </button>
        ) : null}
        <button
          ref={helpButton}
          type="button"
          className="search-help-button"
          aria-label={t('search.help')}
          aria-expanded={helpOpen}
          aria-controls="search-help"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setHelpOpen((open) => !open)}
        >
          {t('search.help.button')}
        </button>
      </label>
      {openSuggestions ? (
        <ul
          id={listId}
          className="tag-suggestions search-suggestions"
          role="listbox"
          aria-label={t('search.suggestions')}
        >
          {match.items.map((item, i) => (
            <li
              key={item.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === activeIndex}
              className={`tag-suggestion search-suggestion${item.status ? ` status-${item.status}` : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => i !== activeIndex && setActive(i)}
              onClick={() => acceptSuggestion(item)}
            >
              {item.tagColor ? <TagDot color={item.tagColor} name={item.label} /> : null}
              {!item.tagColor && item.icon ? <Icon name={item.icon} size="sm" /> : null}
              <span className="picker-name">
                <span className="search-suggestion-prefix">{item.prefix}</span>
                {item.label}
              </span>
              {item.detail ? <span className="search-suggestion-detail">{item.detail}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {helpOpen ? (
        <div
          id="search-help"
          className="search-help"
          role="dialog"
          aria-label={t('search.help')}
          // Focusable, so a click in it keeps the box's focus.
          tabIndex={-1}
        >
          <p className="search-help-intro">{t('search.help.intro')}</p>
          <dl>
            {SYNTAX.map((row) => (
              <div key={row.note}>
                <dt>{row.example}</dt>
                <dd>{t(row.note as MessageKey)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  )
})
