import { forwardRef, useRef } from 'react'
import { t } from './i18n'
import { Icon } from './icons/Icon'
import type { IconName } from './icons/symbols'
import { isImeKey } from './ime'
import { usePickerOpen } from './Picker'

/** The query syntax the help lists: what to type, and the message saying what it does. */
const SYNTAX = [
  { example: 'word  "a phrase"  \'a phrase\'', note: 'search.help.text' },
  { example: 'title:  body:', note: 'search.help.part' },
  { example: 'book:Name', note: 'search.help.book' },
  { example: 'tag:Name', note: 'search.help.tag' },
  { example: 'status:Name', note: 'search.help.status' },
  { example: 'bookId:ID  tagId:ID', note: 'search.help.ids' },
  { example: 'pinned:true  pinned:false', note: 'search.help.pinned' },
  { example: '-word  -book:  -tag:  -status:  -pinned:', note: 'search.help.exclude' },
] as const

/**
 * The toolbar search field. A "?" button opens a list of the query syntax. Escape and the clear button call `onClear`
 * (Escape closes the open syntax list first); the Escape that cancels an
 * input method's composition does neither.
 */
export const SearchField = forwardRef<
  HTMLInputElement,
  {
    value: string
    onChange: (query: string) => void
    onClear: () => void
    /** Says where the search looks (every note, or the current view). */
    placeholder: string
    /** The icon at the field's start (a magnifier by default). */
    icon?: IconName
  }
>(function SearchField({ value, onChange, onClear, placeholder, icon = 'filter' }, ref) {
  const box = useRef<HTMLDivElement>(null)
  const helpButton = useRef<HTMLButtonElement>(null)
  const [helpOpen, setHelpOpen] = usePickerOpen(box)
  return (
    // The field and its syntax list sit side by side in a box: a label may not
    // hold the list, and a click in the list must not focus the field.
    <div
      ref={box}
      className="search-field-box"
      // Escape closes the syntax list before anything else reads it (the
      // field would clear the search).
      onKeyDownCapture={(e) => {
        if (e.key !== 'Escape' || !helpOpen || isImeKey(e.nativeEvent)) return
        e.preventDefault()
        e.stopPropagation()
        setHelpOpen(false)
        if (!(e.target instanceof HTMLInputElement)) helpButton.current?.focus()
      }}
      onBlur={(e) => {
        // Focus left the field and its list (Tab): close the list.
        if (helpOpen && !e.currentTarget.contains(e.relatedTarget)) setHelpOpen(false)
      }}
    >
      <label className="search-field">
        {/* A typed query takes the icon's place; the clear button shows instead. */}
        {value ? null : (
          <span className="search-icon">
            <Icon name={icon} size="sm" />
          </span>
        )}
        <input
          ref={ref}
          type="search"
          // Queries are not prose: no autocorrect, capitalisation or spelling marks.
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label={t('search.label')}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !isImeKey(e.nativeEvent)) {
              e.preventDefault()
              onClear()
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
            onClick={onClear}
          >
            <Icon name="tag.remove" size="sm" />
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
                <dd>{t(row.note)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  )
})
