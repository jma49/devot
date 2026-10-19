import { DEFAULT_NOTEBOOK_SYMBOL } from '../../core/notebookIcons'
import type { TagColor } from '../../core/storage'
import { SymbolIcon, type IconSize } from './icons/Icon'

export const bookIconClass = (color: TagColor | null) =>
  color ? `book-icon book-icon-colored tag-color-${color}` : 'book-icon'

export function BookIcon(props: { icon: string | null; color: TagColor | null; size: IconSize }) {
  return (
    <SymbolIcon
      symbol={props.icon ?? DEFAULT_NOTEBOOK_SYMBOL}
      fallback={DEFAULT_NOTEBOOK_SYMBOL}
      size={props.size}
      className={bookIconClass(props.color)}
    />
  )
}
