import { t } from './i18n'
import type { listEmpty } from './listEmpty'

export function ListEmptyContent({
  text: { message, tip, action },
  onSearchAll,
}: {
  text: ReturnType<typeof listEmpty>
  onSearchAll?: (() => void) | undefined
}) {
  return (
    <>
      <span className="list-empty-message">{t(message)}</span>
      {tip ? <span className="list-empty-tip">{t(tip)}</span> : null}
      {action ? (
        <button type="button" className="button" onClick={onSearchAll}>
          {t(action)}
        </button>
      ) : null}
    </>
  )
}
