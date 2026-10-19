import { useCallback, useEffect, useMemo, useState } from 'react'
import { USAGE_EVENTS, usageCounts, type StoredUsageEvent } from '../../../core/usage'
import type { UsageEventName } from '../../../core/usage'
import { errorCode } from '../backups'
import { ConfirmDialog } from '../ConfirmDialog'
import { countOf } from '../format'
import { currentLocale, format, t, type MessageKey } from '../i18n'
import { clearUsage, listUsage } from '../usage'

const LABELS: Record<UsageEventName, MessageKey> = {
  'note.created': 'usage.event.note.created',
  'search.run': 'usage.event.search.run',
  'import.finished': 'usage.event.import.finished',
}

const SHOWN = 500

/**
 * A catalog event's label. An event from another Devot version keeps its
 * stored name: this list shows exactly what is stored.
 */
const label = (name: string) =>
  Object.hasOwn(USAGE_EVENTS, name) ? t(LABELS[name as UsageEventName]) : name

export function UsageSection() {
  const [events, setEvents] = useState<StoredUsageEvent[]>()
  const [shown, setShown] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [readError, setReadError] = useState<string>()
  const [clearError, setClearError] = useState<string>()
  const locale = currentLocale()

  const load = useCallback(
    () =>
      listUsage().then(
        (list) => {
          setEvents(list)
          setReadError(undefined)
        },
        (e: unknown) => setReadError(errorCode(e)),
      ),
    [],
  )

  useEffect(() => {
    void load()
    const reload = () => void load()
    window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
  }, [load])

  const clear = () => {
    setConfirming(false)
    return clearUsage().then(
      () => {
        // Nothing is stored now, whatever the reload below finds.
        setEvents([])
        setShown(false)
        setClearError(undefined)
        return load()
      },
      (e: unknown) => setClearError(errorCode(e)),
    )
  }

  const count = events?.length ?? 0
  const counts = useMemo(() => usageCounts(events ?? []), [events])
  const formats = useMemo(
    () => ({
      time: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }),
      number: new Intl.NumberFormat(locale),
      list: new Intl.ListFormat(locale, { style: 'short', type: 'unit' }),
    }),
    [locale],
  )
  const properties = (event: StoredUsageEvent) =>
    formats.list.format(
      Object.entries(event.properties).map(([key, value]) =>
        format(t('usage.property'), { key, value: String(value) }),
      ),
    )
  const errors = [
    readError && format(t('usage.failed'), { code: readError }),
    clearError && format(t('usage.clearFailed'), { code: clearError }),
  ].filter(Boolean)

  return (
    <section className="settings-section" aria-labelledby="usage-title">
      <h2 id="usage-title" className="visually-hidden">
        {t('usage.title')}
      </h2>
      <p>{t('usage.detail')}</p>
      <p>{t('usage.limits')}</p>
      {errors.map((text) => (
        <p key={text} role="alert" className="settings-error">
          {text}
        </p>
      ))}
      {events === undefined ? null : count === 0 ? (
        <p>{t('usage.empty')}</p>
      ) : (
        <>
          <p>{countOf(count, locale, 'usage.countOne', 'usage.countOther')}</p>
          <table className="usage-counts" aria-label={t('usage.byType')}>
            <thead>
              <tr>
                <th scope="col">{t('usage.eventColumn')}</th>
                <th scope="col">{t('usage.countColumn')}</th>
              </tr>
            </thead>
            <tbody>
              {counts.map((row) => (
                <tr key={row.name}>
                  <td>{label(row.name)}</td>
                  <td>{formats.number.format(row.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {/* aria-disabled, not disabled: clearing leaves the keyboard on Clear. */}
      <div className="settings-actions">
        <button
          type="button"
          className="button"
          aria-expanded={shown && count > 0}
          aria-disabled={count === 0}
          onClick={() => {
            if (count > 0) setShown((s) => !s)
          }}
        >
          {shown && count > 0 ? t('usage.hide') : t('usage.show')}
        </button>
        <button
          type="button"
          className="button"
          aria-disabled={count === 0}
          onClick={() => {
            if (count > 0) setConfirming(true)
          }}
        >
          {t('usage.clear')}
        </button>
      </div>
      {shown && events && count > 0 ? (
        <>
          {count > SHOWN ? (
            <p>{format(t('usage.newest'), { shown: formats.number.format(SHOWN) })}</p>
          ) : null}
          <ol className="usage-events" aria-label={t('usage.list')}>
            {events.slice(0, SHOWN).map((e) => (
              <li key={e.id}>
                <time dateTime={new Date(e.at).toISOString()}>{formats.time.format(e.at)}</time>
                <span className="usage-name">{label(e.name)}</span>
                <code className="usage-properties">{properties(e)}</code>
              </li>
            ))}
          </ol>
        </>
      ) : null}
      {confirming ? (
        <ConfirmDialog
          message={t('usage.confirmClear')}
          detail={t('usage.confirmClearDetail')}
          confirm={t('usage.confirm')}
          onConfirm={() => void clear()}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </section>
  )
}
