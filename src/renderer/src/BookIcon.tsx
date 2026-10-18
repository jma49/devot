import { DEFAULT_NOTEBOOK_SYMBOL } from '../../core/notebookIcons'
import type { TagColor } from '../../core/storage'
import { SymbolIcon, type IconSize } from './icons/Icon'

/** The classes that draw a notebook icon in a palette colour (app.css `.book-icon-colored`). */
export const bookIconClass = (color: TagColor | null) =>
  color ? `book-icon book-icon-colored tag-color-${color}` : 'book-icon'

/**
 * A notebook's icon: its own catalog symbol, else the default notebook icon,
 * drawn in its palette colour, else in the colour of its parent's text.
 */
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
