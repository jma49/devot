import type { BookNode } from '../../core/books'
import { t } from './i18n'
import { Icon } from './icons/Icon'

export interface BookOption {
  id: string
  name: string
  /** `name` indented by its depth, for flat lists. */
  label: string
}

/** Notebooks in tree order; nesting shown by indentation in the menu. */
export function bookOptions(tree: BookNode[]): BookOption[] {
  const out: BookOption[] = []
  const walk = (nodes: BookNode[]) =>
    nodes.forEach((n) => {
      out.push({ id: n.id, name: n.name, label: `${'   '.repeat(n.depth)}${n.name}` })
      walk(n.children)
    })
  walk(tree)
  return out
}

/** The option value that stands for no notebook. */
export const NO_BOOK = ''

/** The option to show as current: the note's notebook while it is live, else none. */
export function currentBookOption(list: BookOption[], value: string | null): string {
  return value !== null && list.some((o) => o.id === value) ? value : NO_BOOK
}

/** Pop-up button that moves the open note to another notebook. */
export function BookPicker(props: {
  tree: BookNode[]
  value: string | null
  onChange: (bookId: string | null) => void
}) {
  const list = bookOptions(props.tree)
  const value = currentBookOption(list, props.value)
  // A long name is cut off in the control; the tooltip has the whole name.
  const current = list.find((o) => o.id === value)?.name ?? t('note.noBook')
  return (
    <label className="popup">
      <Icon name="notebook" size="sm" />
      <select
        aria-label={t('note.bookLabel')}
        title={current}
        value={value}
        onChange={(e) => props.onChange(e.target.value === NO_BOOK ? null : e.target.value)}
      >
        <option value={NO_BOOK}>{t('note.noBook')}</option>
        {list.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="popup" size="sm" />
    </label>
  )
}
