import type { Writing, WritingWeek } from '../../../../core/activity'
import { displayTitle } from '../../headlines'
import type { ScreensHandlers } from './ops'

/** How many of a week's most edited notes the Activity tab lists. */
export const RANKED_NOTES = 4

/** What the native Activity tab asks of the core (docs/specs/iphone-screens.md, Activity). */
export interface ActivityCore {
  readonly writing: (now: number) => Promise<Writing>
  readonly titles: () => ReadonlyMap<string, string>
}

const week = (figures: WritingWeek, titles: ReadonlyMap<string, string>) => ({
  words: figures.words,
  streak: figures.streak,
  notesEdited: figures.notesEdited,
  ranked: figures.mostEdited
    .flatMap((growth) => {
      const title = titles.get(growth.noteId)
      return title === undefined
        ? []
        : [{ id: growth.noteId, title: displayTitle(title, undefined), words: growth.words }]
    })
    .slice(0, RANKED_NOTES),
})

/** The writing of the last weeks, each day by its number and shade, and each week's figures. */
export function activityHandlers(
  core: () => Promise<ActivityCore>,
  now: () => number = Date.now,
): ScreensHandlers {
  return {
    'activity.writing': async () => {
      const found = await core()
      const writing = await found.writing(now())
      const titles = found.titles()
      return {
        first: writing.first,
        today: writing.today,
        days: writing.days.map((day) => ({ day: day.day, words: day.words, level: day.level })),
        weeks: { this: week(writing.weeks.this, titles), last: week(writing.weeks.last, titles) },
      }
    },
  }
}
