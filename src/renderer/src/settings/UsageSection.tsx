import './usage.css'
import { useEditorSetting } from '../editorSettings'
import { UsageClassicSection } from './UsageClassicSection'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { USAGE_EVENTS, usageCounts, type StoredUsageEvent } from '../../../core/usage'
import type { UsageEventName } from '../../../core/usage'
import { errorCode } from '../backups'
import { ConfirmDialog } from '../ConfirmDialog'
import { countOf } from '../format'
import { currentLocale, format, t, type MessageKey } from '../i18n'
import { clearUsage, listUsage } from '../usage'
import { Select, Setting, SettingsSection } from './controls'
import { usageActivity, usageDayInstant, type UsagePeriod } from '../../../core/usageActivity'
import { dayDate } from '../format'
import { Icon } from '../icons/Icon'
import { useSegmentSlide } from '../segmentSlide'

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

function GlassUsageSection() {
  const [events, setEvents] = useState<StoredUsageEvent[]>()
  const [shown, setShown] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [readError, setReadError] = useState<string>()
  const [clearError, setClearError] = useState<string>()
  const locale = currentLocale()
  const [period, setPeriod] = useState<UsagePeriod>(30)
  const rangeGroup = useRef<HTMLDivElement>(null)
  useSegmentSlide(rangeGroup, ([7, 30, 90] as const).indexOf(period))
  const [eventType, setEventType] = useState('')
  const [now, setNow] = useState(Date.now)
  const request = useRef(0)
  const invalidate = useCallback(() => {
    request.current++
  }, [])

  const load = useCallback(() => {
    const current = ++request.current
    return listUsage().then(
      (list) => {
        if (current !== request.current) return
        setEvents(list)
        setNow(Date.now())
        setReadError(undefined)
      },
      (e: unknown) => {
        if (current === request.current) setReadError(errorCode(e))
      },
    )
  }, [])

  useEffect(() => {
    void load()
    const reload = () => void load()
    window.addEventListener('focus', reload)
    const timer = window.setInterval(reload, 60_000)
    return () => {
      window.removeEventListener('focus', reload)
      window.clearInterval(timer)
      invalidate()
    }
  }, [load, invalidate])

  const clear = () => {
    setConfirming(false)
    request.current++
    return clearUsage().then(
      () => {
        setEvents([])
        setEventType('')
        setShown(false)
        setClearError(undefined)
        return load()
      },
      (e: unknown) => setClearError(errorCode(e)),
    )
  }

  const count = events?.length ?? 0
  const types = useMemo(() => usageCounts(events ?? []), [events])
  const data = useMemo(
    () => usageActivity(events ?? [], now, period, eventType),
    [events, now, period, eventType],
  )
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

  const breakdown = (
    eventType
      ? [eventType]
      : [...new Set([...Object.keys(USAGE_EVENTS), ...data.counts.map((row) => row.name)])]
  ).map((name) => ({ name, count: data.counts.find((row) => row.name === name)?.count ?? 0 }))
  const typeLabel = (name: string) =>
    Object.hasOwn(USAGE_EVENTS, name) ? t(`usage.type.${name as UsageEventName}`) : name
  const number = (n: number) => formats.number.format(n)
  const percent = (n: number) =>
    new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(n)
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(
      Date.UTC(2026, 0, 5 + i),
    ),
  )
  const hour = (n: number) =>
    new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: 'UTC',
    }).format(Date.UTC(2026, 0, 5, n))
  const max = Math.ceil(Math.max(2, ...data.days.map((d) => d.count)) / 2) * 2
  const heatMax = Math.max(1, ...data.hours.flat())
  const dateRange = format(t('usage.rangeDates'), {
    start: dayDate(data.first, locale),
    end: dayDate(data.today, locale),
  })
  const dailyTitle = (day: { day: number; count: number }) =>
    format(t('usage.dayEvents'), {
      date: dayDate(day.day, locale),
      events: countOf(day.count, locale, 'usage.eventsOne', 'usage.eventsOther'),
    })

  const stats = (
    <SettingsSection title="usage.overview" titleHidden>
      <Setting label="usage.total" description={t('usage.periodDetail')}>
        <span className="usage-stat-value">{number(data.total)}</span>
      </Setting>
      <Setting
        label="usage.active"
        description={format(t('usage.dayShare'), { percent: percent(data.activeDays / period) })}
      >
        <span className="usage-stat-value">
          {number(data.activeDays)} {format(t('usage.ofDays'), { days: number(period) })}
        </span>
      </Setting>
      <Setting label="usage.notes" description={t('usage.periodDetail')}>
        <span className="usage-stat-value">{number(data.notes)}</span>
      </Setting>
    </SettingsSection>
  )
  const dailyChart = (
    <svg className="usage-daily" viewBox="0 0 780 125" role="img" aria-label={t('usage.byDay')}>
      {[0, 0.5, 1].map((fraction) => (
        <g key={fraction}>
          <line
            className="usage-gridline"
            x1="30"
            x2="778"
            y1={100 - fraction * 96}
            y2={100 - fraction * 96}
          />
          <text x="24" y={103 - fraction * 96} textAnchor="end">
            {number(Math.round(max * fraction))}
          </text>
        </g>
      ))}
      {data.days.map((day, i) => (
        <rect
          key={day.day}
          className={`usage-bar${day.count === 0 ? ' usage-bar-empty' : ''}`}
          x={32 + (i * 746) / period}
          y={100 - (day.count / max) * 96}
          width={Math.max(1, 746 / period - 6)}
          height={Math.max(1, (day.count / max) * 96)}
          rx="3"
        >
          <title>{dailyTitle(day)}</title>
        </rect>
      ))}
      <line
        className="usage-average"
        x1="30"
        x2="778"
        y1={100 - (data.average / max) * 96}
        y2={100 - (data.average / max) * 96}
      />
      {[0, Math.floor((period - 1) / 2), period - 1].map((i, n) => (
        <text
          key={i}
          x={n === 0 ? 30 : n === 1 ? 404 : 778}
          y="119"
          textAnchor={n === 0 ? 'start' : n === 1 ? 'middle' : 'end'}
        >
          {new Intl.DateTimeFormat(locale, {
            month: 'short',
            day: 'numeric',
            timeZone: 'UTC',
          }).format(usageDayInstant(data.days[i]!.day))}
        </text>
      ))}
    </svg>
  )
  const heatmap = (
    <div className="usage-heat" role="group" aria-label={t('usage.byHour')}>
      {data.hours.map((row, day) => (
        <div className="usage-heat-row" key={day}>
          <span className="usage-weekday">{weekdays[day]}</span>
          {row.map((n, h) => {
            const text = format(t('usage.hourEvents'), {
              day: weekdays[day]!,
              hour: hour(h),
              events: countOf(n, locale, 'usage.eventsOne', 'usage.eventsOther'),
            })
            return (
              <span
                key={h}
                className={`usage-cell activity-level-${n ? Math.max(1, Math.ceil((n / heatMax) * 4)) : 0}`}
                tabIndex={0}
                title={text}
                aria-label={text}
              />
            )
          })}
        </div>
      ))}
      <div className="usage-heat-row usage-hours">
        <span />
        {Array.from({ length: 24 }, (_, i) => (
          <span key={i}>{i % 6 === 0 ? hour(i) : ''}</span>
        ))}
      </div>
    </div>
  )
  const peak = data.peak
    ? format(t('usage.peak'), {
        day: weekdays[data.peak.weekday]!,
        hour: hour(data.peak.hour),
        events: countOf(data.peak.count, locale, 'usage.eventsOne', 'usage.eventsOther'),
      })
    : t('usage.noPeriod')
  const eventList =
    shown && events && count > 0 ? (
      <SettingsSection
        title="usage.list"
        footnote={
          count > SHOWN
            ? format(t('usage.newest'), { shown: formats.number.format(SHOWN) })
            : undefined
        }
      >
        <ol className="usage-events" aria-label={t('usage.list')}>
          {events.slice(0, SHOWN).map((e) => (
            <li key={e.id}>
              <time dateTime={new Date(e.at).toISOString()}>{formats.time.format(e.at)}</time>
              <span className="usage-name">{label(e.name)}</span>
              <code className="usage-properties">{properties(e)}</code>
            </li>
          ))}
        </ol>
      </SettingsSection>
    ) : null
  const confirmDialog = confirming ? (
    <ConfirmDialog
      destructive
      message={t('usage.confirmClear')}
      detail={t('usage.confirmClearDetail')}
      confirm={t('usage.confirm')}
      onConfirm={() => void clear()}
      onCancel={() => setConfirming(false)}
    />
  ) : null
  const typeOptions = (
    <>
      <option value="">{t('usage.all')}</option>
      {[
        ...new Set([
          ...Object.keys(USAGE_EVENTS),
          ...types.map((row) => row.name),
          ...(eventType ? [eventType] : []),
        ]),
      ].map((name) => (
        <option key={name} value={name}>
          {label(name)}
        </option>
      ))}
    </>
  )
  const typeIcon = (name: string) =>
    name === 'note.created'
      ? 'note.new'
      : name === 'search.run'
        ? 'search'
        : name === 'import.finished'
          ? 'usage.import'
          : 'settings.usage'
  const errorList = errors.map((text) => (
    <p key={text} role="alert" className="settings-error">
      {text}
    </p>
  ))

  return (
    <section
      className="settings-section usage-dashboard"
      aria-labelledby="usage-title"
      aria-busy={events === undefined && !readError}
    >
      <h2 id="usage-title" className="visually-hidden">
        {t('usage.title')}
      </h2>
      <p className="usage-privacy">
        <Icon name="usage.private" size="sm" />
        {t('usage.privacy')}
      </p>
      {errorList}
      {events === undefined ? (
        readError ? null : (
          <p role="status">{t('usage.loading')}</p>
        )
      ) : (
        <>
          <div className="usage-filters">
            <div ref={rangeGroup} className="segmented" role="group" aria-label={t('usage.range')}>
              {([7, 30, 90] as const).map((days) => (
                <button
                  key={days}
                  type="button"
                  className="segment"
                  aria-pressed={period === days}
                  onClick={() => setPeriod(days)}
                >
                  {format(t('usage.period'), { days: number(days) })}
                </button>
              ))}
            </div>
            <span className="usage-date-range">{dateRange}</span>
            <Select
              aria-label={t('usage.filter')}
              value={eventType}
              onChange={(e) => setEventType(e.target.value)}
            >
              {typeOptions}
            </Select>
          </div>
          {stats}
          <div className="usage-section-heading">
            <h3>{t('usage.activity')}</h3>
            <span>{countOf(data.total, locale, 'usage.eventsOne', 'usage.eventsOther')}</span>
          </div>
          <section className="usage-card usage-charts" aria-label={t('usage.activity')}>
            <div className="usage-chart-heading">
              <h4>{t('usage.byDay')}</h4>
              <span>
                {format(t('usage.average'), {
                  count: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
                    data.average,
                  ),
                })}
              </span>
            </div>
            {dailyChart}
            <div className="usage-chart-heading usage-heat-heading">
              <h4>{t('usage.byHour')}</h4>
              <span>{t('usage.localTime')}</span>
            </div>
            {heatmap}
            <div className="usage-heat-footer">
              <span>{peak}</span>
              <span className="usage-legend">
                {t('usage.fewer')}
                {[0, 1, 2, 3, 4].map((n) => (
                  <i key={n} className={`activity-level-${n}`} />
                ))}
                {t('usage.more')}
              </span>
            </div>
          </section>
          <p className="usage-footnote">{t('usage.heatDetail')}</p>
          {data.total < 2 ? <p className="usage-footnote">{t('usage.sparse')}</p> : null}
          <div className="usage-section-heading">
            <h3>{t('usage.byType')}</h3>
            <span>{t('usage.share')}</span>
          </div>
          <div className="usage-card usage-types">
            <table className="settings-table" aria-label={t('usage.byType')}>
              <colgroup>
                <col className="usage-type-name" />
                <col />
                <col className="usage-type-share" />
              </colgroup>
              <thead className="visually-hidden">
                <tr>
                  <th>{t('usage.eventColumn')}</th>
                  <th>{t('usage.countColumn')}</th>
                  <th>{t('usage.share')}</th>
                </tr>
              </thead>
              <tbody>
                {breakdown.map((row) => (
                  <tr key={row.name}>
                    <td>
                      <span className="usage-type-label">
                        <Icon size="sm" name={typeIcon(row.name)} />
                        {typeLabel(row.name)}
                      </span>
                    </td>
                    <td>
                      <div className="usage-type-values">
                        <span className="usage-type-track" aria-hidden="true">
                          <i style={{ width: `${(row.count / Math.max(1, data.total)) * 100}%` }} />
                        </span>
                        <span>{number(row.count)}</span>
                      </div>
                    </td>
                    <td className="usage-share">{percent(row.count / Math.max(1, data.total))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.total === 0 ? <p className="usage-no-events">{t('usage.noPeriod')}</p> : null}
          </div>
        </>
      )}
      <SettingsSection title="usage.storage" footnote={t('usage.retained')}>
        <div className="setting usage-storage">
          <div className="setting-text">
            <span className="setting-label">
              {events === undefined
                ? ''
                : count === 0
                  ? t('usage.empty')
                  : countOf(count, locale, 'usage.countOne', 'usage.countOther')}
            </span>
            <span className="setting-description">{t('usage.limits')}</span>
          </div>
          <div className="setting-control">
            <div className="settings-buttons">
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
          </div>
        </div>
        <div className="setting usage-meter">
          <progress max={10000} value={count} aria-label={t('usage.storage')} />
          <span>{format(t('usage.capacity'), { count: number(count), limit: number(10000) })}</span>
        </div>
      </SettingsSection>
      {eventList}
      {confirmDialog}
    </section>
  )
}

export function UsageSection() {
  const glass = useEditorSetting('sidebarMaterial')
  return glass ? <GlassUsageSection /> : <UsageClassicSection />
}
