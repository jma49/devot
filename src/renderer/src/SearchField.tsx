import { forwardRef } from 'react'
import { t } from './i18n'
import { Icon } from './icons/Icon'
import type { IconName } from './icons/symbols'
import { isImeKey } from './ime'

/**
 * The toolbar search field. Escape and the clear button call `onClear`; the
 * Escape that cancels an input method's composition does not.
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
  return (
    <label className="search-field">
      <Icon name={icon} size="sm" />
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
          onClick={onClear}
        >
          <Icon name="tag.remove" size="sm" />
        </button>
      ) : null}
    </label>
  )
})
