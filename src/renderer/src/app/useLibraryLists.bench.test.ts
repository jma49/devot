import { expect, it } from 'vitest'
import { splitTemplates, TEMPLATES_BOOK_ID, type NoteSummary } from '../../../core'
import {
  expectLinearGrowth,
  fourfoldGrowth,
  GROWTH_TIMEOUT,
} from '../../../../tests/support/growth'
import { keepUnchanged } from '../listUpdates'

const summaries = (n: number): NoteSummary[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `0192a6f0-0000-7000-8000-${String(i).padStart(12, '0')}`,
    title: `Note ${i}`,
    createdAt: i,
    updatedAt: i,
    bodyVersion: 0,
    bookId: i % 20 === 0 ? TEMPLATES_BOOK_ID : null,
    status: 'none',
    pinned: false,
    tagIds: i % 3 === 0 ? ['t1', 't2'] : [],
    excerpt: `Excerpt ${i}`,
  }))

/** What the page does with a listed library at start and on each reload. */
function listLibrary(listed: NoteSummary[], shown: NoteSummary[]) {
  const { notes, templates } = splitTemplates(listed)
  return { notes: keepUnchanged(shown, notes), templates }
}

it(
  'builds the note list in time linear in the number of notes',
  (context) => {
    const growth = fourfoldGrowth((n) => {
      const listed = summaries(n)
      const shown = splitTemplates(summaries(n)).notes
      return () => void listLibrary(listed, shown)
    }, 20_000)
    expectLinearGrowth(context, growth)
  },
  GROWTH_TIMEOUT,
)

it('keeps every unchanged note as the object already shown', () => {
  const shown = splitTemplates(summaries(1_000)).notes
  const { notes, templates } = listLibrary(summaries(1_000), shown)
  expect(notes).toBe(shown)
  expect(templates).toHaveLength(50)
})
