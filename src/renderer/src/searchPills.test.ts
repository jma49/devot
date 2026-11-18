import { describe, expect, it } from 'vitest'
import { TEMPLATES_BOOK_ID } from '../../core/books'
import type { BookRecord, TagRecord } from '../../core/storage'
import {
  applySearchSuggestion,
  backspaceSearchPill,
  composeSearchValue,
  removeSearchPill,
  searchSuggestions,
  splitSearchPills,
} from './searchPills'

const book = (id: string, name: string): BookRecord => ({
  id,
  name,
  nameHlc: '1',
  parentId: null,
  parentHlc: '',
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  deletedHlc: null,
  aiAccess: false,
  aiAccessHlc: '',
  sortKey: id,
  sortKeyHlc: '',
  icon: null,
  iconColor: null,
  iconHlc: '',
})

const tag = (id: string, name: string): TagRecord => ({
  id,
  name,
  nameHlc: '1',
  color: null,
  colorHlc: '',
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  deletedHlc: null,
})

const BOOKS = [
  book(TEMPLATES_BOOK_ID, 'Templates'),
  book('b1', 'Work'),
  book('b2', 'Weekly notes'),
  book('b3', 'Recipes'),
]

const TAGS = [tag('t1', 'urgent'), tag('t2', 'project log'), tag('t3', 'reading')]

describe('splitSearchPills', () => {
  it('keeps an unspaced trailing qualifier in draft so saved searches keep their input value', () => {
    expect(splitSearchPills('status:active', { books: BOOKS, tags: TAGS })).toEqual({
      pills: [],
      draft: 'status:active',
    })
  })

  it('extracts leading whitespace-terminated filter qualifiers including negations and quotes', () => {
    const res = splitSearchPills('in:"Weekly notes" -tag:urgent is:on_hold pinned:true roadmap', {
      books: BOOKS,
      tags: TAGS,
    })
    expect(res.draft).toBe('roadmap')
    expect(res.pills.map((p) => [p.negate, p.key, p.value, p.raw])).toEqual([
      [false, 'in', 'Weekly notes', 'in:"Weekly notes"'],
      [true, 'tag', 'urgent', '-tag:urgent'],
      [false, 'is', 'on_hold', 'is:on_hold'],
      [false, 'pinned', 'true', 'pinned:true'],
    ])
  })

  it('keeps unclosed quotes and unknown hashtags in draft', () => {
    expect(splitSearchPills('in:"Weekly ', { books: BOOKS, tags: TAGS })).toEqual({
      pills: [],
      draft: 'in:"Weekly ',
    })
    expect(splitSearchPills('#include ', { books: BOOKS, tags: TAGS })).toEqual({
      pills: [],
      draft: '#include ',
    })
    const knownHash = splitSearchPills('#urgent -#reading ', { books: BOOKS, tags: TAGS })
    expect(knownHash.draft).toBe('')
    expect(knownHash.pills.map((p) => p.raw)).toEqual(['#urgent', '-#reading'])
  })

  it('handles removing individual pills and Backspace unwrap or removal cleanly', () => {
    const parsed = splitSearchPills('in:Work -tag:urgent roadmap', { books: BOOKS, tags: TAGS })
    expect(removeSearchPill('in:Work -tag:urgent roadmap', parsed.pills[0]!)).toBe(
      '-tag:urgent roadmap',
    )
    expect(removeSearchPill('in:Work -tag:urgent roadmap', parsed.pills[1]!)).toBe(
      'in:Work roadmap',
    )

    const emptyDraft = splitSearchPills('in:Work -tag:urgent ', { books: BOOKS, tags: TAGS })
    expect(backspaceSearchPill('in:Work -tag:urgent ', emptyDraft.pills, emptyDraft.draft)).toBe(
      'in:Work -tag:urgent',
    )
    expect(backspaceSearchPill('in:Work -tag:urgent roadmap', parsed.pills, parsed.draft)).toBe(
      'in:Work roadmap',
    )
    expect(composeSearchValue(parsed.pills, 'plan')).toBe('in:Work -tag:urgent plan')
  })
})

describe('searchSuggestions', () => {
  it('suggests notebooks (excluding Templates), quotes names with spaces, and supports - negation', () => {
    const all = searchSuggestions('in:', 3, { books: BOOKS, tags: TAGS })
    expect(all.items.map((s) => s.clause)).toEqual(['in:Work', 'in:"Weekly notes"', 'in:Recipes'])

    const filtered = searchSuggestions('-book:we', 8, { books: BOOKS, tags: TAGS })
    expect(filtered.items.map((s) => s.clause)).toEqual(['-book:"Weekly notes"'])

    const quoted = searchSuggestions('in:"week', 8, { books: BOOKS, tags: TAGS })
    expect(quoted.items.map((s) => s.clause)).toEqual(['in:"Weekly notes"'])
  })

  it('suggests tags for tag: and # qualifiers', () => {
    const byKey = searchSuggestions('tag:proj', 8, { books: BOOKS, tags: TAGS })
    expect(byKey.items.map((s) => s.clause)).toEqual(['tag:"project log"'])

    const byHash = searchSuggestions('-#u', 3, { books: BOOKS, tags: TAGS })
    expect(byHash.items.map((s) => s.clause)).toEqual(['-#urgent'])
  })

  it('suggests statuses and pinned values, and hoists accepted suggestions to pills', () => {
    const statuses = searchSuggestions('-is:', 4, {})
    expect(statuses.items.map((s) => s.clause)).toEqual([
      '-is:none',
      '-is:active',
      '-is:on_hold',
      '-is:completed',
      '-is:dropped',
    ])

    const hold = searchSuggestions('status:hold', 11, {})
    expect(hold.items.map((s) => s.clause)).toEqual(['status:on_hold'])

    const pinned = searchSuggestions('-pinned:t', 9, {})
    expect(pinned.items.map((s) => s.clause)).toEqual(['-pinned:true'])

    const ctx = searchSuggestions('roadmap in:we', 13, { books: BOOKS, tags: TAGS })
    expect(applySearchSuggestion([], 'roadmap in:we', ctx, ctx.items[0]!)).toBe(
      'in:"Weekly notes" roadmap',
    )

    const atStart = searchSuggestions('in:we', 5, { books: BOOKS, tags: TAGS })
    expect(applySearchSuggestion([], 'in:we', atStart, atStart.items[0]!)).toBe(
      'in:"Weekly notes" ',
    )
  })

  it('falls back to bookId/tagId when names contain both quotes, preserves tagId color, and matches core apostrophe rules', () => {
    const trickyBookId = '01950000-0000-7000-8000-000000000001'
    const trickyTagId = '01950000-0000-7000-8000-000000000002'
    const trickyBooks: BookRecord[] = [
      ...BOOKS,
      book(trickyBookId, 'Clients\' "urgent"'),
      book('01950000-0000-7000-8000-000000000003', "Don't stop"),
    ]
    const trickyTags: TagRecord[] = [
      ...TAGS,
      { ...tag(trickyTagId, 'Clients\' "urgent"'), color: 'red' },
    ]

    expect(searchSuggestions('in:cl', 5, { books: trickyBooks }).items[0]?.clause).toBe(
      `bookId:${trickyBookId}`,
    )
    expect(searchSuggestions('-in:cl', 6, { books: trickyBooks }).items[0]?.clause).toBe(
      `-bookId:${trickyBookId}`,
    )
    expect(searchSuggestions('tag:cl', 6, { tags: trickyTags }).items[0]?.clause).toBe(
      `tagId:${trickyTagId}`,
    )
    expect(searchSuggestions('-#cl', 4, { tags: trickyTags }).items[0]?.clause).toBe(
      `-tagId:${trickyTagId}`,
    )

    const idPill = splitSearchPills(`tagId:${trickyTagId} `, { tags: trickyTags })
    expect(idPill.pills).toHaveLength(1)
    expect(idPill.pills[0]?.tagColor).toBe('red')

    expect(searchSuggestions("in:'don't s", 11, { books: trickyBooks }).items[0]?.label).toBe(
      "Don't stop",
    )

    const apostrophePrefix = searchSuggestions("'tis in:we", 10, { books: trickyBooks })
    expect(apostrophePrefix.start).toBe(5)
    expect(apostrophePrefix.end).toBe(10)
    expect(apostrophePrefix.items[0]?.clause).toBe('in:"Weekly notes"')
    expect(
      applySearchSuggestion([], "'tis in:we", apostrophePrefix, apostrophePrefix.items[0]!),
    ).toBe('in:"Weekly notes" \'tis')
  })
})
