import { DEFAULT_NOTEBOOK_SYMBOL } from '../../core/notebookIcons'
import type { TagColor } from '../../core/storage'
import { useEditorSetting } from './editorSettings'
import { Icon, SymbolIcon, type IconSize } from './icons/Icon'

export const bookIconClass = (color: TagColor | null) =>
  color ? `book-icon book-icon-colored tag-color-${color}` : 'book-icon'

/** A notebook's own icon is its user's choice and stays an SF Symbol in every icon style; only the default one follows the style. */
export function BookIcon(props: { icon: string | null; color: TagColor | null; size: IconSize }) {
  const style = useEditorSetting('iconStyle')
  if (props.icon === null && style === 'lucide')
    return <Icon name="notebook" size={props.size} className={bookIconClass(props.color)} />
  return (
    <SymbolIcon
      symbol={props.icon ?? DEFAULT_NOTEBOOK_SYMBOL}
      fallback={DEFAULT_NOTEBOOK_SYMBOL}
      size={props.size}
      className={bookIconClass(props.color)}
    />
  )
}
