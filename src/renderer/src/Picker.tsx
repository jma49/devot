import {
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { closingRef } from './closing'
import { dropdownNotchX, placeDropdown } from './dropdownPlacement'
import { Icon } from './icons/Icon'
import { isImeKey } from './ime'

export interface PickerOption {
  id: string
  content: ReactNode
  depth?: number
  className?: string
}

export function pickerStep(key: string, from: number, count: number): number | undefined {
  if (count === 0) return -1
  switch (key) {
    case 'ArrowDown':
      return from < 0 ? 0 : Math.min(count - 1, from + 1)
    case 'ArrowUp':
      return from < 0 ? count - 1 : Math.max(0, from - 1)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return undefined
  }
}

/**
 * The row Up or Down moves to from a typing field over a list (a dialog's
 * search, the tag field): the same steps as `pickerStep`, while Home and End
 * stay with the field's text.
 */
export function fieldStep(key: string, from: number, count: number): number | undefined {
  return key === 'ArrowDown' || key === 'ArrowUp' ? pickerStep(key, from, count) : undefined
}

export function usePickerOpen(box: RefObject<HTMLElement | null>) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (e.target instanceof Node && box.current?.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open, box])
  return [open, setOpen] as const
}

const pickerRef = closingRef('scale', 'picker-popover')

/**
 * A pop-over list under a pop-up button: Up, Down, Home and End move
 * through it, Return picks, Escape closes; the trigger gets the keyboard
 * back. With `search`, a field above the rows takes the keyboard and
 * narrows them (the owner filters `options`).
 */
export function PickerList(props: {
  label: string
  options: readonly PickerOption[]
  value: string | undefined
  onPick: (id: string) => void
  onClose: () => void
  search?: {
    placeholder: string
    query: string
    onQuery: (query: string) => void
    /** The option to make active for a query (the first one otherwise). */
    pick?: (query: string) => string | undefined
  }
  empty?: string
}) {
  const { options, value } = props
  const listId = useId()
  const start = options.findIndex((o) => o.id === value)
  // Held as an id: a query change rebuilds the rows, and the row picked for
  // the new query is the one to keep active, whatever index it lands on.
  const [activeOption, setActiveOption] = useState<string | undefined>(
    options[start >= 0 ? start : 0]?.id,
  )
  const found = options.findIndex((o) => o.id === activeOption)
  const shownActive = found >= 0 ? found : options.length > 0 ? 0 : -1
  const list = useRef<HTMLUListElement>(null)
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (field.current) field.current.focus()
    else list.current?.focus()
  }, [])
  // Measured once it is on the page: flipped over the button when there is
  // no room below, kept inside the window, and no taller than the room left.
  useLayoutEffect(() => {
    const panel = list.current?.closest<HTMLElement>('.picker-popover')
    const anchor = panel?.parentElement
    if (!panel || !anchor) return
    const css = getComputedStyle(panel)
    const px = (name: string) => Number.parseFloat(css.getPropertyValue(name))
    const a = anchor.getBoundingClientRect()
    const p = placeDropdown(
      a,
      { width: panel.offsetWidth, height: panel.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      { gap: px('--picker-gap') || px('--space-2') || 4, margin: px('--size-popover-margin') || 8 },
    )
    panel.dataset['side'] = p.side
    panel.style.left = `${p.shift}px`
    panel.style.setProperty('--picker-room', `${p.room}px`)
    panel.style.setProperty(
      '--picker-notch-x',
      `${dropdownNotchX({
        anchorWidth: a.width,
        shift: p.shift,
        panelWidth: panel.offsetWidth,
        clear: px('--radius-popover') + px('--size-glass-popover-notch'),
      })}px`,
    )
  }, [])
  useEffect(() => {
    if (shownActive < 0) return
    list.current
      ?.querySelector(`[data-index="${shownActive}"]`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [shownActive])
  const onKeyDown = (e: KeyboardEvent) => {
    if (isImeKey(e.nativeEvent)) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      return props.onClose()
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const option = options[shownActive]
      if (option) props.onPick(option.id)
      return
    }
    if (e.key === 'Tab') return props.onClose()
    // With a search field the focus is in text: Home and End stay with the caret.
    const next = (props.search ? fieldStep : pickerStep)(e.key, shownActive, options.length)
    if (next === undefined) return
    e.preventDefault()
    setActiveOption(options[next]?.id)
  }
  const optionId = (i: number) => `${listId}-${i}`
  const activeId = shownActive >= 0 ? optionId(shownActive) : undefined
  return (
    <div ref={pickerRef} className="picker-popover" onKeyDown={onKeyDown}>
      {props.search ? (
        <div className="picker-search-field">
          <span className="picker-search-icon">
            <Icon name="search" size="sm" />
          </span>
          <input
            ref={field}
            type="search"
            className="picker-search"
            role="combobox"
            aria-label={props.search.placeholder}
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeId}
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={props.search.placeholder}
            value={props.search.query}
            onChange={(e) => {
              const next = e.target.value
              props.search?.onQuery(next)
              setActiveOption(props.search?.pick?.(next))
            }}
          />
        </div>
      ) : null}
      <ul
        ref={list}
        id={listId}
        className="picker-list"
        role="listbox"
        aria-label={props.label}
        tabIndex={props.search ? undefined : -1}
        aria-activedescendant={props.search ? undefined : activeId}
      >
        {options.map((o, i) => (
          <li
            key={o.id}
            id={optionId(i)}
            data-index={i}
            role="option"
            aria-selected={i === shownActive}
            data-current={o.id === value || undefined}
            className={`picker-option${o.className ? ` ${o.className}` : ''}`}
            style={
              o.depth
                ? {
                    paddingInlineStart: `calc(var(--space-4) + ${o.depth} * var(--space-6))`,
                  }
                : undefined
            }
            // The field or list keeps the keyboard.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => props.onPick(o.id)}
          >
            {o.content}
          </li>
        ))}
        {options.length === 0 && props.empty ? (
          <li className="picker-empty" role="presentation">
            {props.empty}
          </li>
        ) : null}
      </ul>
    </div>
  )
}
