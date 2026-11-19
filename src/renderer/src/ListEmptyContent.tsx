import { t, type MessageKey } from './i18n'

export function ListEmptyContent({
  text: { message, tip, action },
  onSearchAll,
  as: Container = 'div',
}: {
  text: { message: MessageKey; tip?: MessageKey | undefined; action?: MessageKey }
  onSearchAll?: (() => void) | undefined
  as?: 'div' | 'li'
}) {
  return (
    <Container className="list-empty" role={Container === 'li' ? 'presentation' : undefined}>
      <span className="list-empty-message">{t(message)}</span>
      {tip ? <span className="list-empty-tip">{t(tip)}</span> : null}
      {action ? (
        <button type="button" className="button" onClick={onSearchAll}>
          {t(action)}
        </button>
      ) : null}
    </Container>
  )
}
