import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { closingRef } from '../closing'
import { format, t, type MessageKey } from '../i18n'
import { Icon } from '../icons/Icon'
import {
  addMonths,
  boundsFor,
  dayAllowed,
  dayKeyMove,
  dayOf,
  monthGrid,
  pendingAt,
  pendingOf,
  pendingProblem,
  sameDay,
  setDayPeriod,
  shownHour,
  stepSegment,
  typeSegment,
  usesDayPeriod,
  weekStartOf,
  type DateField,
  type Day,
  type Pending,
  type Segment,
} from './calendar'
import type { NoteInfoData } from './infoCard'

export type DateOutcome = 'saved' | 'refused' | 'failed'

const pickerRef = closingRef('scale', 'date-picker')

const pad = (n: number) => String(n).padStart(2, '0')

interface ClockWords {
  separator: string
  am: string
  pm: string
}

function clockWords(locale: string): ClockWords {
  const parts = (hour: number) =>
    new Intl.DateTimeFormat(locale, {
      hour: 'numeric',
      minute: '2-digit',
      hourCycle: 'h12',
    }).formatToParts(new Date(2000, 0, 1, hour, 5))
  const morning = parts(9)
  const hourAt = morning.findIndex((part) => part.type === 'hour')
  const separator = morning[hourAt + 1]?.type === 'literal' ? morning[hourAt + 1]!.value : ':'
  const period = (list: Intl.DateTimeFormatPart[]) =>
    list.find((part) => part.type === 'dayPeriod')?.value ?? ''
  return { separator, am: period(morning), pm: period(parts(21)) }
}

function weekdays(weekStart: number, locale: string) {
  const short = new Intl.DateTimeFormat(locale, { weekday: 'narrow' })
  const long = new Intl.DateTimeFormat(locale, { weekday: 'long' })
  // 4 January 1970 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => {
    const date = new Date(1970, 0, 4 + ((weekStart + i) % 7))
    return { short: short.format(date), long: long.format(date) }
  })
}

const dayKey = (d: Day) => `${d.year}-${d.month}-${d.day}`

/**
 * A glass pop-up that sets Created or Updated: a month of days and the time, Set and Cancel.
 * Return sets from anywhere but a button, Escape cancels; the arrows, Page Up and Page Down move the
 * day, and T goes to today.
 */
export function DatePicker(props: {
  field: DateField
  label: string
  at: number
  info: Pick<NoteInfoData, 'createdAt' | 'updatedAt'>
  locale: string
  onPending: (at: number | null) => void
  onCancel: () => void
  onSet: (at: number) => Promise<DateOutcome>
}) {
  const { field, label, at, info, locale, onPending, onCancel, onSet } = props
  const [pending, setPending] = useState<Pending>(() => pendingOf(at))
  const [focusDay, setFocusDay] = useState<Day>(() => dayOf(at))
  const [view, setView] = useState(() => ({ year: dayOf(at).year, month: dayOf(at).month }))
  const [slide, setSlide] = useState<'next' | 'previous'>()
  const [failed, setFailed] = useState<MessageKey>()
  const [today] = useState(() => dayOf(Date.now()))
  const [weekStart] = useState(() => weekStartOf(locale))
  const [dayPeriod] = useState(() => usesDayPeriod(locale))
  const [words] = useState(() => clockWords(locale))
  const typed = useRef('')
  const grid = useRef<HTMLDivElement>(null)
  const segments = useRef<Partial<Record<Segment, HTMLSpanElement | null>>>({})
  const moveFocus = useRef(true)
  const id = useId()
  const bounds = boundsFor(field, info)
  const blocked = pendingProblem(field, pending, info)
  const problem = failed ?? blocked

  useEffect(() => onPending(pendingAt(pending)), [pending, onPending])
  useLayoutEffect(() => {
    if (!moveFocus.current) return
    moveFocus.current = false
    grid.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus()
  })

  const showMonth = (next: Day) => {
    const before = view.year * 12 + view.month
    const after = next.year * 12 + next.month
    if (after !== before) {
      setSlide(after > before ? 'next' : 'previous')
      setView({ year: next.year, month: next.month })
    }
  }
  const change = (next: Pending) => {
    setFailed(undefined)
    setPending(next)
  }
  const goTo = (next: Day, focus: boolean) => {
    showMonth(next)
    setFocusDay(next)
    if (dayAllowed(next, bounds)) change({ ...pending, day: next })
    moveFocus.current = focus
  }
  const turnMonth = (by: number) => {
    const next = addMonths({ ...view, day: 1 }, by)
    setSlide(by > 0 ? 'next' : 'previous')
    setView({ year: next.year, month: next.month })
    setFocusDay(addMonths(focusDay, by))
  }
  const set = () => {
    const next = pendingAt(pending)
    if (next === null || blocked) return
    void onSet(next).then((outcome) => {
      if (outcome === 'failed') setFailed('noteInfo.dateFailed')
      else if (outcome === 'refused') setFailed(pendingProblem(field, pending, info))
    })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    } else if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault()
      event.stopPropagation()
      set()
    }
  }
  const onGridKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === 't' || event.key === 'T') {
      event.preventDefault()
      return goTo(today, true)
    }
    const next = dayKeyMove(focusDay, event.key, weekStart, event.shiftKey)
    if (!next) return
    event.preventDefault()
    goTo(next, true)
  }
  const onSegmentKey = (segment: Segment) => (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const order: Segment[] = dayPeriod ? ['hour', 'minute', 'dayPeriod'] : ['hour', 'minute']
    const index = order.indexOf(segment)
    const focus = (i: number) => {
      typed.current = ''
      segments.current[order[i]!]?.focus()
    }
    const key = event.key
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      typed.current = ''
      change(stepSegment(pending, segment, key === 'ArrowUp' ? 1 : -1, dayPeriod))
    } else if (key === 'ArrowLeft' && index > 0) focus(index - 1)
    else if (key === 'ArrowRight' && index < order.length - 1) focus(index + 1)
    else if ((key === 'Backspace' || key === 'Delete') && segment !== 'dayPeriod') {
      typed.current = ''
      change({ ...pending, [segment]: null })
    } else if (/^\d$/.test(key) && segment !== 'dayPeriod') {
      const next = typeSegment(pending, segment, typed.current, key, dayPeriod)
      change(next.pending)
      typed.current = next.typed
      if (next.done && index < order.length - 1) focus(index + 1)
    } else if (segment === 'dayPeriod' && /^[ap]$/i.test(key)) {
      change(setDayPeriod(pending, key.toLowerCase() === 'p'))
    } else return
    event.preventDefault()
  }

  const cells = monthGrid(view, weekStart, {
    today,
    selected: pending.day,
    bounds,
  })
  const tabDay = cells.some((c) => sameDay(c, focusDay)) ? focusDay : pending.day
  const dayLabel = new Intl.DateTimeFormat(locale, { dateStyle: 'full' })
  const monthTitle = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(
    new Date(view.year, view.month, 1),
  )
  const segment = (
    name: Segment,
    text: string,
    value: number | null,
    range: [number, number],
    valueText?: string,
  ) => (
    <span
      ref={(el) => {
        segments.current[name] = el
      }}
      role="spinbutton"
      tabIndex={0}
      className="date-picker-segment"
      data-segment={name}
      aria-label={t(
        name === 'hour'
          ? 'noteInfo.hour'
          : name === 'minute'
            ? 'noteInfo.minute'
            : 'noteInfo.dayPeriod',
      )}
      aria-valuemin={range[0]}
      aria-valuemax={range[1]}
      aria-valuenow={value ?? undefined}
      aria-valuetext={valueText}
      onKeyDown={onSegmentKey(name)}
      onBlur={() => {
        typed.current = ''
      }}
    >
      {text}
    </span>
  )
  const pm = (pending.hour ?? 0) >= 12

  return (
    <div
      ref={pickerRef}
      className="date-picker"
      role="dialog"
      aria-label={format(t('noteInfo.datePicker'), { field: label })}
      onKeyDown={onKeyDown}
    >
      <div className="date-picker-head">
        <span id={`${id}-month`} className="date-picker-month" aria-live="polite">
          {monthTitle}
        </span>
        <button
          type="button"
          className="date-picker-nav"
          aria-label={t('noteInfo.previousMonth')}
          onClick={() => turnMonth(-1)}
        >
          <Icon name="nav.back" size="xs" />
        </button>
        <button
          type="button"
          className="date-picker-nav date-picker-today"
          aria-label={t('noteInfo.thisMonth')}
          onClick={() => goTo(today, true)}
        >
          <span className="date-picker-dot" />
        </button>
        <button
          type="button"
          className="date-picker-nav"
          aria-label={t('noteInfo.nextMonth')}
          onClick={() => turnMonth(1)}
        >
          <Icon name="nav.forward" size="xs" />
        </button>
      </div>
      <div
        ref={grid}
        role="grid"
        className="date-picker-grid"
        aria-labelledby={`${id}-month`}
        onKeyDown={onGridKey}
      >
        <div role="row" className="date-picker-week">
          {weekdays(weekStart, locale).map((day) => (
            <span key={day.long} role="columnheader" aria-label={day.long}>
              {day.short}
            </span>
          ))}
        </div>
        <div
          key={`${view.year}-${view.month}`}
          className="date-picker-days"
          data-slide={slide}
          role="rowgroup"
        >
          {Array.from({ length: 6 }, (_, week) => (
            <div key={week} role="row" className="date-picker-row">
              {cells.slice(week * 7, week * 7 + 7).map((cell) => (
                <span
                  key={dayKey(cell)}
                  role="gridcell"
                  className="date-picker-day"
                  tabIndex={sameDay(cell, tabDay) ? 0 : -1}
                  aria-label={dayLabel.format(new Date(cell.year, cell.month, cell.day))}
                  aria-selected={cell.selected}
                  aria-disabled={cell.disabled || undefined}
                  aria-current={cell.today ? 'date' : undefined}
                  data-outside={cell.outside || undefined}
                  data-today={cell.today || undefined}
                  onClick={() => goTo(cell, true)}
                >
                  <span className="date-picker-circle">{cell.day}</span>
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="date-picker-time">
        <span id={`${id}-time`} className="date-picker-time-label">
          {t('noteInfo.time')}
        </span>
        <span className="date-picker-clock" role="group" aria-labelledby={`${id}-time`}>
          {segment(
            'hour',
            pending.hour === null ? '--' : pad(shownHour(pending.hour, dayPeriod)),
            pending.hour === null ? null : shownHour(pending.hour, dayPeriod),
            dayPeriod ? [1, 12] : [0, 23],
          )}
          <span className="date-picker-colon" aria-hidden="true">
            {words.separator}
          </span>
          {segment(
            'minute',
            pending.minute === null ? '--' : pad(pending.minute),
            pending.minute,
            [0, 59],
          )}
          {dayPeriod
            ? segment(
                'dayPeriod',
                pm ? words.pm : words.am,
                pm ? 1 : 0,
                [0, 1],
                pm ? words.pm : words.am,
              )
            : null}
        </span>
        <button
          type="button"
          className="date-picker-button"
          onClick={() => {
            const now = pendingOf(Date.now())
            showMonth(now.day)
            setFocusDay(now.day)
            change(now)
          }}
        >
          {t('noteInfo.now')}
        </button>
      </div>
      <p id={`${id}-problem`} className="date-picker-note" role="alert">
        {problem ? t(problem) : null}
      </p>
      <div className="date-picker-foot">
        <button type="button" className="date-picker-button" onClick={onCancel}>
          {t('noteInfo.cancel')}
        </button>
        <button
          type="button"
          className="date-picker-button date-picker-set"
          aria-disabled={blocked ? true : undefined}
          aria-describedby={problem ? `${id}-problem` : undefined}
          onClick={set}
        >
          {t('noteInfo.set')}
        </button>
      </div>
    </div>
  )
}
