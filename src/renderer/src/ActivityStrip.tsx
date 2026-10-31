import { memo } from 'react'
import type { RowDetail } from '../../core'
import { localDay, STRIP_DAYS, systemOffset, type StripDay } from '../../core/activity'
import { errorCode } from '../../core/errors'
import type { HeadlineLoader } from './headlines'
import { countOf, dayDate } from './format'
import { format, t } from './i18n'

/** The days of `days` from today back, shown for a strip read on an earlier day too: a day since then had no activity, or the row would have been read again. */
export function stripDays(days: readonly StripDay[], now: number): StripDay[] {
  const today = localDay(now, systemOffset)
  const byDay = new Map(days.map((d) => [d.day, d]))
  return Array.from({ length: STRIP_DAYS }, (_, i) => {
    const day = today - STRIP_DAYS + 1 + i
    return byDay.get(day) ?? { day, edits: 0, chars: 0, level: 0 }
  })
}

export type RowInfo = Partial<RowDetail> & { strip?: StripDay[] }

/** A row's details and its strip read together, so a note's change renders its row once for both. A strip that cannot be read leaves the details alone. */
export function withStrips(
  details: HeadlineLoader<RowDetail> | undefined,
  activity: HeadlineLoader<StripDay[]> | undefined,
): HeadlineLoader<RowInfo> | undefined {
  if (!activity) return details
  return async (ids) => {
    const [found, strips] = await Promise.all([
      details ? details(ids) : ({} as Record<string, RowDetail>),
      activity(ids).catch((e: unknown) => {
        console.warn('W_ACTIVITY_STRIPS_FAILED', errorCode(e))
        return {} as Record<string, StripDay[]>
      }),
    ])
    const out: Record<string, RowInfo> = {}
    for (const id of ids) {
      const detail = found[id]
      const strip = strips[id]
      if (detail || strip) out[id] = { ...detail, ...(strip ? { strip } : {}) }
    }
    return out
  }
}

function dayTitle(day: StripDay, locale: string): string {
  const totals =
    day.edits === 0
      ? t('activity.none')
      : day.chars > 0
        ? countOf(day.chars, locale, 'activity.charsOne', 'activity.charsOther')
        : t('activityStrip.edited')
  return format(t('activity.day'), { date: dayDate(day.day, locale), totals })
}

/** A note's last STRIP_DAYS days in a list row, shaded like the Activity sheet's days; one image for assistive tech, named by its active days. */
export const ActivityStrip = memo(function ActivityStrip(props: {
  days: readonly StripDay[]
  now: number
  locale: string
}) {
  const days = stripDays(props.days, props.now)
  const active = days.filter((d) => d.edits > 0).length
  if (active === 0) return null
  return (
    <span
      className="activity-strip"
      role="img"
      aria-label={format(t('activityStrip.label'), {
        days: countOf(active, props.locale, 'activity.activeDaysOne', 'activity.activeDaysOther'),
      })}
    >
      {days.map((day) => (
        <span
          key={day.day}
          className={`activity-strip-day activity-level-${day.level}`}
          title={dayTitle(day, props.locale)}
        />
      ))}
    </span>
  )
})
