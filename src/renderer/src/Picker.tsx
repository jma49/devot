import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { closingRef } from './closing'
import { isImeKey } from './ime'

/** One row of a picker's pop-over. */
export interface PickerOption {
  /** What picking it hands back. */
  id: string
  /** What the row shows. */
  content: ReactNode
  /** Its nesting depth, for an indented tree. */
  depth?: number
  className?: string
}

/** The row `key` moves to from `from` among `count` rows (-1 when there are none). */
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

/**
 * Open state for a pop-up button: what opens and closes it, and a click
 * anywhere outside `box` closing it.
 */
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

/** A picker shrinks back toward its button as it closes. */
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
  /** The row shown as current (in bold, and where the keyboard starts). */
  value: string | undefined
  onPick: (id: string) => void
  onClose: () => void
  search?: { placeholder: string; query: string; onQuery: (query: string) => void }
  /** Shown when no row is left. */
  empty?: string
}) {
  const { options, value } = props
  const listId = useId()
  const start = options.findIndex((o) => o.id === value)
  const [active, setActive] = useState(start >= 0 ? start : options.length > 0 ? 0 : -1)
  const list = useRef<HTMLUListElement>(null)
  const field = useRef<HTMLInputElement>(null)
  // The keyboard goes to the search field, else the list.
  useEffect(() => {
    if (field.current) field.current.focus()
    else list.current?.focus()
  }, [])
  // A narrower list keeps the keyboard on a row that is still there.
  const shownActive = active >= options.length ? options.length - 1 : active
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
    const next = pickerStep(e.key, shownActive, options.length)
    if (next === undefined) return
    e.preventDefault()
    setActive(next)
  }
  const optionId = (i: number) => `${listId}-${i}`
  const activeId = shownActive >= 0 ? optionId(shownActive) : undefined
  return (
    <div ref={pickerRef} className="picker-popover" onKeyDown={onKeyDown}>
      {props.search ? (
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
            props.search?.onQuery(e.target.value)
            setActive(0)
          }}
        />
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
                ? { paddingInlineStart: `calc(var(--space-4) + ${o.depth} * var(--space-6))` }
                : undefined
            }
            // The field or list keeps the keyboard.
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setActive(i)}
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
