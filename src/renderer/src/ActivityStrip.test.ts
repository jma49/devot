import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RowDetail } from '../../core'
import { localDay, STRIP_DAYS, systemOffset, type StripDay } from '../../core/activity'
import { stripDays, withStrips } from './ActivityStrip'

const NOW = Date.UTC(2026, 9, 25, 12)
const today = localDay(NOW, systemOffset)
const day = (d: number, chars = 50): StripDay => ({ day: d, edits: 1, chars, level: 1 })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('stripDays', () => {
  it('is the last STRIP_DAYS days ending today, empty where nothing was read', () => {
    const days = stripDays([day(today), day(today - 3)], NOW)
    expect(days).toHaveLength(STRIP_DAYS)
    expect(days[0]?.day).toBe(today - STRIP_DAYS + 1)
    expect(days.at(-1)).toEqual(day(today))
    expect(days.at(-4)).toEqual(day(today - 3))
    expect(days.at(-2)).toEqual({ day: today - 1, edits: 0, chars: 0, level: 0 })
  })

  it('moves on past midnight: a strip read yesterday loses its oldest day and gains an empty today', () => {
    const yesterday = today - 1
    const read = Array.from({ length: STRIP_DAYS }, (_, i) => day(yesterday - STRIP_DAYS + 1 + i))
    const days = stripDays(read, NOW)
    expect(days[0]?.day).toBe(today - STRIP_DAYS + 1)
    expect(days.map((d) => d.day)).not.toContain(yesterday - STRIP_DAYS + 1)
    expect(days.at(-1)).toEqual({ day: today, edits: 0, chars: 0, level: 0 })
    expect(days.at(-2)).toEqual(day(yesterday))
  })
})

describe('withStrips', () => {
  const details = (ids: readonly string[]) =>
    Promise.resolve(
      Object.fromEntries(ids.map((id) => [id, { excerpt: `about ${id}`, progress: '' }])) as Record<
        string,
        RowDetail
      >,
    )

  it('is the details loader alone when there are no strips to read', () => {
    expect(withStrips(details, undefined)).toBe(details)
    expect(withStrips(undefined, undefined)).toBeUndefined()
  })

  it('reads details and strips together, one entry per note', async () => {
    const load = withStrips(details, (ids) =>
      Promise.resolve(Object.fromEntries(ids.map((id) => [id, [day(today)]]))),
    )
    await expect(load?.(['a', 'b'])).resolves.toEqual({
      a: { excerpt: 'about a', progress: '', strip: [day(today)] },
      b: { excerpt: 'about b', progress: '', strip: [day(today)] },
    })
  })

  it('keeps the details when the strips cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const load = withStrips(details, () => Promise.reject(new Error('E_STORAGE_READ')))
    await expect(load?.(['a'])).resolves.toEqual({ a: { excerpt: 'about a', progress: '' } })
    expect(warn).toHaveBeenCalledWith('W_ACTIVITY_STRIPS_FAILED', expect.any(String))
  })

  it('reads strips alone when the rows show no details', async () => {
    const load = withStrips(undefined, (ids) =>
      Promise.resolve(Object.fromEntries(ids.map((id) => [id, [day(today)]]))),
    )
    await expect(load?.(['a'])).resolves.toEqual({ a: { strip: [day(today)] } })
  })
})
