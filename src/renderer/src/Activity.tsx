import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
// Imported directly (not through the core index) so the main bundle does not
// pull in the rest of the core.
import { ACTIVITY_LEVELS, DAY_MS, weekday, type ActivityHeatmap } from '../../core/activity'
import { errorCode } from './backups'
import type { Core } from './core-client'
import { countOf } from './format'
import { currentLocale, format, t } from './i18n'

/** View > Activity… in the menu bar; App re-sends the Tauri event as this. */
export const SHOW_ACTIVITY = 'devot:show-activity'

/** Calls `open` for View > Activity… (the menu bar), unless another sheet is up. */
export function useActivityMenu(open: () => void) {
  const latest = useRef(open)
  useEffect(() => {
    latest.current = open
  })
  useEffect(() => {
    const show = () => {
      if (!document.querySelector('dialog[open]')) latest.current()
    }
    window.addEventListener(SHOW_ACTIVITY, show)
    let stopped = false
    let unlisten: (() => void) | undefined
    if (!DEVOT_UI_TEST) {
      import('@tauri-apps/api/event')
        .then(async ({ listen }) => {
          const stop = await listen('devot://show-activity', () =>
            window.dispatchEvent(new CustomEvent(SHOW_ACTIVITY)),
          )
          if (stopped) stop()
          else unlisten = stop
        })
        .catch(() => console.warn('W_ACTIVITY_MENU_LISTEN_FAILED'))
    }
    return () => {
      stopped = true
      window.removeEventListener(SHOW_ACTIVITY, show)
      unlisten?.()
    }
  }, [])
}

/** A day number (see core/activity.ts) as a date; day numbers count UTC days. */
const dateOf = (day: number, locale: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(day * DAY_MS)

const listOf = (parts: string[], locale: string) =>
  new Intl.ListFormat(locale, { type: 'unit', style: 'long' }).format(parts)

/** What each day's square says, in order: its date and what happened. */
function dayLabels(heatmap: ActivityHeatmap, locale: string): string[] {
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeZone: 'UTC' })
  const list = new Intl.ListFormat(locale, { type: 'unit', style: 'long' })
  return heatmap.days.map((day) => {
    const parts = [
      day.created
        ? countOf(day.created, locale, 'activity.createdOne', 'activity.createdOther')
        : '',
      day.edited ? countOf(day.edited, locale, 'activity.editedOne', 'activity.editedOther') : '',
      day.chars ? countOf(day.chars, locale, 'activity.charsOne', 'activity.charsOther') : '',
    ].filter(Boolean)
    return format(t('activity.day'), {
      date: date.format(day.day * DAY_MS),
      totals: parts.length ? list.format(parts) : t('activity.none'),
    })
  })
}

/**
 * Month names over the weeks where a month starts, kept apart enough to
 * read: the first week is labelled unless the next label is too close, and
 * the last two weeks are not (a name would run past the grid).
 */
function monthLabels(first: number, weeks: number, locale: string): string[] {
  const month = (week: number) => new Date((first + week * 7) * DAY_MS).getUTCMonth()
  const labels = Array.from({ length: weeks }, (_, week) =>
    week > 0 && week < weeks - 2 && month(week) !== month(week - 1)
      ? dateOf(first + week * 7, locale, { month: 'short' })
      : '',
  )
  if (labels.slice(1, 3).every((label) => label === '')) {
    labels[0] = dateOf(first, locale, { month: 'short' })
  }
  return labels
}

const WEEKDAYS = 7

/**
 * The Activity sheet: a heatmap of the last 52 weeks, weeks as columns and
 * Monday first, each day a square shaded by how much was written. Hovering
 * or moving the focus to a day shows its totals; the grid is navigated with
 * the arrow keys (a week left and right, a day up and down), Home and End.
 */
export function Activity(props: { core: Core; onClose: () => void }) {
  const { core } = props
  const dialog = useRef<HTMLDialogElement>(null)
  const grid = useRef<HTMLDivElement>(null)
  const [heatmap, setHeatmap] = useState<ActivityHeatmap>()
  const [error, setError] = useState<string>()
  // The day with the keyboard focus (a roving tab stop), and the one under the pointer.
  const [active, setActive] = useState<number>()
  const [hovered, setHovered] = useState<number>()
  const locale = currentLocale()

  useLayoutEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
    // Closing (rather than only removing) the dialog gives the keyboard back.
    return () => el?.close()
  }, [])

  useEffect(() => {
    let current = true
    core.activity(Date.now()).then(
      (found) => {
        if (!current) return
        setHeatmap(found)
        setActive(found.today)
      },
      (e: unknown) => current && setError(format(t('activity.failed'), { code: errorCode(e) })),
    )
    return () => {
      current = false
    }
  }, [core])

  useEffect(() => {
    if (active === undefined) return
    grid.current?.querySelector<HTMLElement>(`[data-day="${active}"]`)?.focus()
  }, [active])

  const weeks = heatmap ? Math.ceil(heatmap.days.length / WEEKDAYS) : 0
  const columns = Array.from({ length: weeks }, (_, week) => week)
  // Built once per count: hovering re-renders the grid.
  const labels = useMemo(() => (heatmap ? dayLabels(heatmap, locale) : []), [heatmap, locale])
  const shown = (day: number | undefined) =>
    heatmap && day !== undefined ? heatmap.days[day - heatmap.first] : undefined
  const readout = shown(hovered) ?? shown(active)

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!heatmap || active === undefined) return
    // Up and down stay in the day's week (its column).
    const row = weekday(active)
    const step: Record<string, number> = {
      ArrowLeft: -7,
      ArrowRight: 7,
      ArrowUp: row > 0 ? -1 : 0,
      ArrowDown: row < WEEKDAYS - 1 ? 1 : 0,
    }
    const next =
      e.key in step
        ? active + step[e.key]!
        : e.key === 'Home'
          ? heatmap.first
          : e.key === 'End'
            ? heatmap.today
            : undefined
    if (next === undefined) return
    e.preventDefault()
    if (next >= heatmap.first && next <= heatmap.today) setActive(next)
  }

  const summary = heatmap
    ? listOf(
        [
          countOf(heatmap.total.chars, locale, 'activity.charsOne', 'activity.charsOther'),
          countOf(heatmap.total.created, locale, 'activity.createdOne', 'activity.createdOther'),
          countOf(
            heatmap.total.activeDays,
            locale,
            'activity.activeDaysOne',
            'activity.activeDaysOther',
          ),
        ],
        locale,
      )
    : ''

  return (
    <dialog
      ref={dialog}
      className="sheet activity"
      aria-labelledby="activity-title"
      onCancel={(e) => {
        e.preventDefault()
        props.onClose()
      }}
      onClose={(e) => {
        if (e.target === e.currentTarget && !dialog.current?.open) props.onClose()
      }}
    >
      <h2 id="activity-title" className="sheet-title">
        {t('activity.title')}
      </h2>
      <p className="sheet-detail">{t('activity.detail')}</p>
      {error ? (
        <p role="alert" className="sheet-error">
          {error}
        </p>
      ) : null}
      {heatmap ? (
        <>
          <div className="activity-head">
            <p className="activity-summary">{summary}</p>
            <div className="activity-legend">
              <span>{t('activity.less')}</span>
              {Array.from({ length: ACTIVITY_LEVELS + 1 }, (_, level) => (
                <span key={level} className={`activity-cell activity-level-${level}`} aria-hidden />
              ))}
              <span>{t('activity.more')}</span>
            </div>
          </div>
          <div className="activity-chart">
            <div className="activity-months" aria-hidden="true">
              {monthLabels(heatmap.first, weeks, locale).map((label, week) => (
                <span key={week} className="activity-month">
                  {label}
                </span>
              ))}
            </div>
            <div className="activity-weekdays" aria-hidden="true">
              {Array.from({ length: WEEKDAYS }, (_, row) => (
                <span key={row}>
                  {/* Monday, Wednesday and Friday, as on a wall calendar. */}
                  {row % 2 === 0 && row < 6
                    ? dateOf(heatmap.first + row, locale, { weekday: 'short' })
                    : ''}
                </span>
              ))}
            </div>
            <div
              ref={grid}
              role="grid"
              aria-label={t('activity.grid')}
              aria-readonly="true"
              className="activity-grid"
              onKeyDown={onKeyDown}
              onMouseLeave={() => setHovered(undefined)}
            >
              {Array.from({ length: WEEKDAYS }, (_, row) => (
                <div key={row} role="row" className="activity-row">
                  {columns.map((week) => {
                    const info = shown(heatmap.first + week * 7 + row)
                    if (!info) {
                      return (
                        <span key={week} className="activity-cell activity-future" aria-hidden />
                      )
                    }
                    return (
                      <span
                        key={week}
                        role="gridcell"
                        data-day={info.day}
                        tabIndex={info.day === active ? 0 : -1}
                        aria-label={labels[info.day - heatmap.first]}
                        className={`activity-cell activity-level-${info.level}`}
                        onFocus={() => setActive(info.day)}
                        onMouseEnter={() => setHovered(info.day)}
                      />
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
          {/* The grid's cells carry the same text for assistive tech. */}
          <p className="activity-readout" aria-hidden="true">
            {readout ? labels[readout.day - heatmap.first] : ''}
          </p>
          <p className="activity-footnote">{t('activity.footnote')}</p>
        </>
      ) : null}
      <div className="confirm-actions">
        <button type="button" className="button" onClick={props.onClose}>
          {t('activity.done')}
        </button>
      </div>
    </dialog>
  )
}
