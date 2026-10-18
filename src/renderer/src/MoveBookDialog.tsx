import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { moveTargets, type BookNode } from '../../core/books'
import { format, t } from './i18n'
import { Icon } from './icons/Icon'
import { BookIcon } from './BookIcon'
import { fieldStep } from './Picker'

const optionId = (i: number) => `move-book-option-${i}`

/** The option that stands for the top level. */
const TOP = ''

/**
 * Picks where a notebook goes: the top level or inside another notebook. The
 * notebook itself and the notebooks below it are listed but cannot be picked.
 * Arrow keys skip them; Return or a click moves, Escape cancels.
 */
export function MoveBookDialog(props: {
  tree: readonly BookNode[]
  /** The notebook to move. */
  book: { id: string; name: string; parentId: string | null }
  onMove: (parentId: string | null) => void
  onCancel: () => void
}) {
  const { book } = props
  const dialog = useRef<HTMLDialogElement>(null)
  const list = useRef<HTMLUListElement>(null)
  useLayoutEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
    // The list takes the keyboard once, so the arrow keys work at once.
    list.current?.focus({ preventScroll: true })
    // Closing (rather than only removing) the dialog gives the keyboard back.
    return () => el?.close()
  }, [])

  const options = [
    {
      id: TOP,
      name: t('moveBook.topLevel'),
      depth: 0,
      icon: null,
      iconColor: null,
      disabled: false,
    },
    ...moveTargets(props.tree, book.id),
  ]
  const current = book.parentId ?? TOP
  const enabled = options.flatMap((o, i) => (o.disabled ? [] : [i]))
  const [active, setActive] = useState(() => enabled.find((i) => options[i]?.id !== current) ?? 0)

  useEffect(() => {
    document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const pick = (index: number) => {
    const option = options[index]
    if (!option || option.disabled) return
    if (option.id === current) return props.onCancel()
    props.onMove(option.id === TOP ? null : option.id)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const at = fieldStep(e.key, enabled.indexOf(active), enabled.length)
    if (at !== undefined) {
      e.preventDefault()
      const next = enabled[at]
      if (next !== undefined) setActive(next)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(active)
    }
  }

  return (
    <dialog
      ref={dialog}
      className="sheet move-note"
      aria-labelledby="move-book-title"
      aria-describedby="move-book-detail"
      onCancel={(e) => {
        e.preventDefault()
        props.onCancel()
      }}
    >
      <h2 id="move-book-title" className="sheet-title">
        {t('moveBook.title')}
      </h2>
      <p id="move-book-detail" className="sheet-detail">
        {format(t('moveBook.detail'), { name: book.name })}
      </p>
      <ul
        id="move-book-options"
        className="pick-list"
        role="listbox"
        aria-label={t('sidebar.notebooks')}
        aria-activedescendant={optionId(active)}
        tabIndex={0}
        ref={list}
        onKeyDown={onKeyDown}
      >
        {options.map((o, i) => (
          <li
            key={o.id || 'top'}
            id={optionId(i)}
            className="pick-row"
            role="option"
            aria-selected={i === active}
            aria-checked={o.id === current}
            aria-disabled={o.disabled || undefined}
            style={{ paddingInlineStart: `calc(var(--space-4) + ${o.depth} * var(--space-7))` }}
            onMouseMove={() => !o.disabled && setActive(i)}
            onClick={() => pick(i)}
          >
            {o.id === TOP ? (
              <span className="picker-icon-slot" aria-hidden="true" />
            ) : (
              <BookIcon icon={o.icon} color={o.iconColor} size="sm" />
            )}
            <span className="pick-name">{o.name}</span>
            {o.id === current ? <Icon name="check" size="sm" /> : null}
          </li>
        ))}
      </ul>
      <div className="confirm-actions">
        <button type="button" className="button" onClick={props.onCancel}>
          {t('dialog.cancel')}
        </button>
      </div>
    </dialog>
  )
}
