import { useRef, useState } from 'react'
import type { BookNode } from '../../core/books'
import { t } from './i18n'
import { Icon } from './icons/Icon'
import { PickerList, usePickerOpen, type PickerOption } from './Picker'

export interface BookOption {
  id: string
  name: string
  /** `name` indented by its depth, for flat lists. */
  label: string
  /** How deep it is nested (0: top level). */
  depth: number
  /** The notebooks it is nested in, outermost first. */
  ancestors: string[]
}

/** Notebooks in tree order; nesting shown by indentation in the menu. */
export function bookOptions(tree: BookNode[]): BookOption[] {
  const out: BookOption[] = []
  const walk = (nodes: BookNode[], ancestors: string[]) =>
    nodes.forEach((n) => {
      out.push({
        id: n.id,
        name: n.name,
        label: `${'   '.repeat(n.depth)}${n.name}`,
        depth: n.depth,
        ancestors,
      })
      walk(n.children, [...ancestors, n.id])
    })
  walk(tree, [])
  return out
}

/**
 * The notebooks the picker's search leaves: those whose names hold `query`
 * (any case), with the notebooks they are nested in, in tree order. All of
 * them for an empty query.
 */
export function filterBooks(list: readonly BookOption[], query: string): BookOption[] {
  const want = query.trim().toLocaleLowerCase()
  if (!want) return [...list]
  const keep = new Set<string>()
  for (const o of list) {
    if (!o.name.toLocaleLowerCase().includes(want)) continue
    keep.add(o.id)
    for (const id of o.ancestors) keep.add(id)
  }
  return list.filter((o) => keep.has(o.id))
}

/** The option value that stands for no notebook. */
export const NO_BOOK = ''

/** The option to show as current: the note's notebook while it is live, else none. */
export function currentBookOption(list: BookOption[], value: string | null): string {
  return value !== null && list.some((o) => o.id === value) ? value : NO_BOOK
}

/**
 * Pop-up button that moves the open note to another notebook: a book icon,
 * the notebook's name in bold and a chevron. It opens a pop-over with a
 * search field over the indented notebook tree (No Notebook first), the
 * current notebook in bold.
 */
export function BookPicker(props: {
  tree: BookNode[]
  value: string | null
  onChange: (bookId: string | null) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = usePickerOpen(box)
  const [query, setQuery] = useState('')
  const list = bookOptions(props.tree)
  const value = currentBookOption(list, props.value)
  // A long name is cut off in the control; the tooltip has the whole name.
  const current = list.find((o) => o.id === value)?.name ?? t('note.noBook')
  const shown = filterBooks(list, query)
  const noBook = t('note.noBook')
  const options: PickerOption[] = [
    ...(query.trim() === '' || noBook.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
      ? [
          {
            id: NO_BOOK,
            // An empty icon slot, so its name lines up with the notebooks'.
            content: (
              <>
                <span className="picker-icon-slot" aria-hidden="true" />
                <span className="picker-name">{noBook}</span>
              </>
            ),
          },
        ]
      : []),
    ...shown.map((o) => ({
      id: o.id,
      depth: o.depth,
      content: (
        <>
          <Icon name="notebook" size="sm" />
          <span className="picker-name">{o.name}</span>
        </>
      ),
    })),
  ]
  const toggle = (next: boolean) => {
    setQuery('')
    setOpen(next)
  }
  const close = () => {
    toggle(false)
    button.current?.focus()
  }
  return (
    <div ref={box} className="picker">
      <button
        ref={button}
        type="button"
        className="popup book-popup"
        aria-label={t('note.bookLabel')}
        data-value={value}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={current}
        onClick={() => toggle(!open)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' || open) return
          e.preventDefault()
          toggle(true)
        }}
      >
        <Icon name="notebook" size="sm" />
        <span className="popup-value">{current}</span>
        <Icon name="popup.chevron" size="xs" />
      </button>
      {open ? (
        <PickerList
          label={t('note.bookLabel')}
          options={options}
          value={value}
          onClose={close}
          onPick={(id) => {
            close()
            if (id !== value) props.onChange(id === NO_BOOK ? null : id)
          }}
          search={{ placeholder: t('note.searchBooks'), query, onQuery: setQuery }}
          empty={t('note.noBooksFound')}
        />
      ) : null}
    </div>
  )
}
