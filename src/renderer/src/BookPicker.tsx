import { useRef, useState } from 'react'
import type { BookNode } from '../../core/books'
import type { TagColor } from '../../core/storage'
import { BookIcon } from './BookIcon'
import type { MenuPoint } from './contextMenu'
import { format, t } from './i18n'
import { Icon } from './icons/Icon'
import { PickerList, usePickerOpen, type PickerOption } from './Picker'

export interface BookOption {
  id: string
  name: string
  depth: number
  ancestors: string[]
  icon: string | null
  iconColor: TagColor | null
}

export function bookOptions(tree: BookNode[]): BookOption[] {
  const out: BookOption[] = []
  const walk = (nodes: BookNode[], ancestors: string[]) =>
    nodes.forEach((n) => {
      out.push({
        id: n.id,
        name: n.name,
        depth: n.depth,
        ancestors,
        icon: n.icon,
        iconColor: n.iconColor,
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

/**
 * The notebook a typed query starts on: the best of those whose own name holds
 * it (an exact name first, then a name it starts, then any), in list order.
 * A notebook kept only because a match is nested in it is context, never the
 * choice.
 */
export function firstBookMatch(list: readonly BookOption[], query: string): BookOption | undefined {
  const want = query.trim().toLocaleLowerCase()
  if (!want) return list[0]
  const rank = (o: BookOption) => {
    const name = o.name.toLocaleLowerCase()
    const byName = name === want ? 0 : name.startsWith(want) ? 1 : 2
    // A notebook named for the query beats No Notebook however the two match:
    // taking the note out of its notebook is the last thing typing it means.
    return o.id === NO_BOOK ? byName + 3 : byName
  }
  let best: BookOption | undefined
  for (const o of list) {
    if (!o.name.toLocaleLowerCase().includes(want)) continue
    if (!best || rank(o) < rank(best)) best = o
  }
  return best
}

export const NO_BOOK = ''

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
  onMenu?: (bookId: string, at: MenuPoint) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = usePickerOpen(box)
  const [query, setQuery] = useState('')
  const list = bookOptions(props.tree)
  const value = currentBookOption(list, props.value)
  // A long name is cut off in the control; the tooltip has the whole name.
  const chosen = list.find((o) => o.id === value)
  const current = chosen?.name ?? t('note.noBook')
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
          <BookIcon icon={o.icon} color={o.iconColor} size="sm" />
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
        aria-label={format(t('note.bookValue'), { book: current })}
        data-value={value}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => toggle(!open)}
        onContextMenu={(e) => {
          if (value === NO_BOOK || !props.onMenu) return
          e.preventDefault()
          props.onMenu(value, { x: e.clientX, y: e.clientY })
        }}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' || open) return
          e.preventDefault()
          toggle(true)
        }}
      >
        <BookIcon icon={chosen?.icon ?? null} color={chosen?.iconColor ?? null} size="sm" />
        <span className="popup-value" title={current}>
          {current}
        </span>
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
          search={{
            placeholder: t('note.searchBooks'),
            query,
            onQuery: setQuery,
            pick: (next) =>
              firstBookMatch(
                filterBooks(
                  [
                    {
                      id: NO_BOOK,
                      name: noBook,
                      depth: 0,
                      ancestors: [],
                      icon: null,
                      iconColor: null,
                    },
                    ...list,
                  ],
                  next,
                ),
                next,
              )?.id,
          }}
          empty={t('note.noBooksFound')}
        />
      ) : null}
    </div>
  )
}
