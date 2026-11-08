// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { WRITING_WEEKS } from '../../../../core/activity'
import { createClock } from '../../../../core/hlc'
import { createIdGenerator } from '../../../../core/ids'
import { createNoteService } from '../../../../core/notes/service'
import { memoryStorage } from '../../storage/memory'
import { activityHandlers, RANKED_NOTES, type ActivityCore } from './activity'

interface Answer {
  first: number
  today: number
  days: { day: number; words: number; level: number }[]
  weeks: Record<
    'this' | 'last',
    {
      words: number
      streak: number
      notesEdited: number
      ranked: { id: string; title: string; words: number }[]
    }
  >
}

function measuring(titles: () => ReadonlyMap<string, string>) {
  const notes = createNoteService({
    storage: memoryStorage,
    clock: createClock('activity1'),
    newId: createIdGenerator(),
    saveDelayMs: 60_000,
  })
  const core: ActivityCore = { writing: (now) => notes.writing(now), titles }
  const handler = activityHandlers(() => core)['activity.writing']
  if (!handler) throw new Error('no activity handler')
  return { notes, run: () => handler({}) as Promise<Answer> }
}

describe('the native Activity tab operation', () => {
  it('answers each day of the last weeks and this week the notes that grew, most first', async () => {
    const titles = new Map<string, string>()
    const { notes, run } = measuring(() => titles)
    const small = await notes.create('Small')
    await notes.setBody(small, 'one two')
    const big = await notes.create('Big')
    await notes.setBody(big, 'one two three four five six')
    titles.set(small, 'Small').set(big, 'Big')
    const answer = await run()
    expect(answer.days).toHaveLength(WRITING_WEEKS * 7 - (6 - ((answer.today + 3) % 7)))
    expect(answer.days.at(-1)?.day).toBe(answer.today)
    expect(answer.weeks.this.ranked.map((note) => note.title)).toStrictEqual(['Big', 'Small'])
    expect(answer.weeks.this.ranked[0]?.id).toBe(big)
    expect(answer.weeks.this.notesEdited).toBe(2)
    expect(answer.weeks.last.ranked).toStrictEqual([])
  })

  it('lists only notes it can name, at most a few', async () => {
    const titles = new Map<string, string>()
    const { notes, run } = measuring(() => titles)
    for (let n = 0; n <= RANKED_NOTES + 1; n += 1) {
      const id = await notes.create(`Note ${n}`)
      await notes.setBody(id, 'words '.repeat(n + 1))
      if (n > 0) titles.set(id, `Note ${n}`)
    }
    const { ranked } = (await run()).weeks.this
    expect(ranked).toHaveLength(RANKED_NOTES)
    expect(ranked.map((note) => note.title)).not.toContain('Note 0')
  })

  it('refuses until the core has started', async () => {
    const handler = activityHandlers(() => null)['activity.writing']
    await expect(handler?.({})).rejects.toThrow('E_SCREENS_UNAVAILABLE')
  })
})
