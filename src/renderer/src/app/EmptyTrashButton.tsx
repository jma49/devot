import { t } from '../i18n'
import { ToolIcon } from '../icons/Icon'

/** The Trash list's action, shaped like New Note; aria-disabled keeps the keyboard on it. */
export function EmptyTrashButton({
  disabled,
  onClick,
}: {
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="tool list-create"
      data-tauri-drag-region="false"
      aria-label={t('trash.empty')}
      title={t('trash.empty')}
      aria-disabled={disabled}
      onClick={onClick}
    >
      <ToolIcon name="trash.empty" />
    </button>
  )
}
