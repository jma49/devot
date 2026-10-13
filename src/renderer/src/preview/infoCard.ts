// What the preview's note info card shows (NoteInfo.tsx): task progress when
// the note has tasks, then when it was created and last updated.
import type { TaskProgress } from '../../../core/tasks'
import { stampDate, taskCount } from '../format'
import { t } from '../i18n'
import type { IconName } from '../icons/symbols'

/** The note the info card is about. */
export interface NoteInfoData {
  noteId: string
  createdAt: number
  updatedAt: number
}

export interface InfoField {
  key: 'progress' | 'created' | 'updated'
  icon: IconName
  label: string
  value: string
  /** The progress field's bar. */
  tasks?: TaskProgress
  /** The dates' machine-readable time. */
  dateTime?: string
}

/** The card's fields, in order. Progress shows only for a note with tasks. */
export function infoFields(info: NoteInfoData, tasks: TaskProgress, locale: string): InfoField[] {
  const date = (key: 'created' | 'updated', icon: IconName, at: number): InfoField => ({
    key,
    icon,
    label: t(key === 'created' ? 'noteInfo.created' : 'noteInfo.updated'),
    value: stampDate(at),
    dateTime: new Date(at).toISOString(),
  })
  return [
    ...(tasks.total > 0
      ? [
          {
            key: 'progress',
            icon: 'progress',
            label: t('noteInfo.progress'),
            value: taskCount(tasks.done, tasks.total, locale),
            tasks,
          } satisfies InfoField,
        ]
      : []),
    date('created', 'date.created', info.createdAt),
    date('updated', 'date.updated', info.updatedAt),
  ]
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * A time as a date-time field's value (`YYYY-MM-DDTHH:mm:ss`), in local
 * time, to the second.
 */
export function dateInputValue(at: number): string {
  const d = new Date(at)
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const DATE_INPUT = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/

/**
 * The time a date-time field's value (`YYYY-MM-DDTHH:mm`, seconds optional,
 * a space for the `T` too) names in local time; null for anything else,
 * a date that does not exist (February 30) included.
 */
export function parseDateInput(value: string): number | null {
  const match = DATE_INPUT.exec(value.trim())
  if (!match) return null
  const [year, month, day, hours, minutes, seconds] = match.slice(1).map((n) => Number(n ?? 0))
  const d = new Date(year!, month! - 1, day!, hours!, minutes!, seconds!)
  const exists =
    d.getFullYear() === year &&
    d.getMonth() === month! - 1 &&
    d.getDate() === day &&
    d.getHours() === hours &&
    d.getMinutes() === minutes &&
    d.getSeconds() === seconds
  const at = d.getTime()
  return exists && at >= 0 ? at : null
}

/**
 * The dates to write when field `key` is set to `at`; null when the note
 * would be updated before it was created.
 */
export function datesEdit(
  info: Pick<NoteInfoData, 'createdAt' | 'updatedAt'>,
  key: 'created' | 'updated',
  at: number,
): { createdAt: number } | { updatedAt: number } | null {
  if (key === 'created') return at <= info.updatedAt ? { createdAt: at } : null
  return at >= info.createdAt ? { updatedAt: at } : null
}

const BACKLINKS_OPEN_KEY = 'devot.preview.backlinksOpen'

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>

function viewStorage(): KeyValue | undefined {
  try {
    return (globalThis as { localStorage?: KeyValue }).localStorage
  } catch {
    return undefined
  }
}

/**
 * Whether "Linked to this note" is open: a view preference of the window,
 * the same for every note, kept in the web view's storage (closed at first).
 */
export function backlinksOpen(storage: KeyValue | undefined = viewStorage()): boolean {
  try {
    return storage?.getItem(BACKLINKS_OPEN_KEY) === '1'
  } catch {
    return false
  }
}

export function setBacklinksOpen(open: boolean, storage: KeyValue | undefined = viewStorage()) {
  try {
    storage?.setItem(BACKLINKS_OPEN_KEY, open ? '1' : '0')
  } catch {
    // A view preference that cannot be kept is only forgotten.
  }
}
