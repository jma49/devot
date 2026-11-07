// Apart from dailyNotes.ts, so the editor settings read them without the template engine.
export type DailyTitleFormat = 'iso' | 'dayMonthYear' | 'weekdayDayMonthYear'
export const DAILY_TITLE_FORMATS: readonly DailyTitleFormat[] = [
  'iso',
  'dayMonthYear',
  'weekdayDayMonthYear',
]
