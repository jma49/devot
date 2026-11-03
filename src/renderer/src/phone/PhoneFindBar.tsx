import { useEffect, useState, type KeyboardEvent } from 'react'
import { t } from '../i18n'
import { Icon } from '../icons/Icon'
import { NO_MATCHES, type FindStatus, type FindTarget } from '../find/target'
import { WithFigures } from './PhoneControls'

/** The editor's find, in a glass bar above the keyboard. */
export function PhoneFindBar(props: {
  target: FindTarget | null
  keyboardHeight: number
  onClose: () => void
}) {
  const { target } = props
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<FindStatus>(NO_MATCHES)
  useEffect(() => {
    if (!target) return
    const stop = target.subscribe((change) => {
      if (change === 'status') setStatus(target.status())
    })
    target.search({ query, regexp: false, caseSensitive: false })
    return stop
  }, [target, query])
  useEffect(() => () => target?.clear(), [target])
  const close = () => {
    target?.clear()
    props.onClose()
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (event.shiftKey) target?.previous()
      else target?.next()
    }
    if (event.key === 'Escape') close()
  }
  const count = query ? (
    <WithFigures
      template={t('phone.find.count')}
      values={{
        current: String(status.current === null ? 0 : status.current + 1),
        total: String(status.total),
      }}
    />
  ) : null
  const none = status.total === 0
  return (
    <div
      className="phone-find"
      style={{ bottom: `calc(${props.keyboardHeight}px + var(--size-phone-sheet-inset))` }}
    >
      <div role="search" className="phone-glass phone-find-bar">
        <input
          autoFocus
          type="search"
          className="phone-search-input"
          aria-label={t('phone.note.find')}
          placeholder={t('phone.note.find')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <output className="phone-find-count">{count}</output>
        <button
          type="button"
          className="phone-accessory-button"
          aria-label={t('phone.find.previous')}
          disabled={none}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => target?.previous()}
        >
          <Icon name="phone.find.previous" size="md" />
        </button>
        <button
          type="button"
          className="phone-accessory-button"
          aria-label={t('phone.find.next')}
          disabled={none}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => target?.next()}
        >
          <Icon name="phone.find.next" size="md" />
        </button>
      </div>
      <button
        type="button"
        className="phone-glass phone-accessory-hide"
        aria-label={t('phone.find.close')}
        onClick={close}
      >
        <Icon name="phone.close" size="md" />
      </button>
    </div>
  )
}
