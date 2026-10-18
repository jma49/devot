import { describe, expect, it } from 'vitest'
import type { OffsetAt } from './activity'
import { TEMPLATES_BOOK_ID } from './books'
import { excludeTemplates, parseSearch, resolveSearch, type SearchScope } from './search'
import type { BookRecord, NoteQuery } from './storage'
import {
  draftFromTemplate,
  expandTemplate,
  formatDate,
  resolveNotebook,
  TEMPLATE_KEYS,
  withoutInstructions,
} from './templates'
import { isStarterTemplate, STARTER_TEMPLATES } from './starterTemplates'
import { withoutFrontMatterKeys } from './import'

/** The offset of a named IANA time zone at an instant, through `Intl`. */
function zoneOffset(timeZone: string): OffsetAt {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  })
  return (at) => {
    const part = new Map(format.formatToParts(at).map((p) => [p.type, Number(p.value)]))
    const wall = Date.UTC(
      part.get('year') ?? 1970,
      (part.get('month') ?? 1) - 1,
      part.get('day') ?? 1,
      part.get('hour') ?? 0,
      part.get('minute') ?? 0,
      part.get('second') ?? 0,
    )
    return Math.round((wall - Math.floor(at / 1000) * 1000) / 60_000)
  }
}

const UTC: OffsetAt = () => 0
const LA = zoneOffset('America/Los_Angeles')
const SHANGHAI = zoneOffset('Asia/Shanghai')
const KATHMANDU = zoneOffset('Asia/Kathmandu')

/** An instant, from an ISO string with its offset. */
const at = (iso: string) => Date.parse(iso)

// Tuesday 2026-03-03 09:05:07 UTC.
const NOW = at('2026-03-03T09:05:07Z')

describe('formatDate', () => {
  it('writes every token on the wall clock of the zone', () => {
    const f = (pattern: string) => formatDate(NOW, pattern, { offsetAt: UTC })
    expect(f('YYYY-MM-DD')).toBe('2026-03-03')
    expect(f('YY/M/D')).toBe('26/3/3')
    expect(f('HH:mm:ss')).toBe('09:05:07')
    expect(f('H:m:s')).toBe('9:5:7')
    expect(f('hh:mm A')).toBe('09:05 AM')
    expect(f('h a')).toBe('9 am')
    expect(f('dddd, MMMM D')).toBe('Tuesday, March 3')
    expect(f('ddd MMM')).toBe('Tue Mar')
    expect(f('Z')).toBe('+00:00')
  })

  it('keeps text in brackets and characters that are no token as written', () => {
    const f = (pattern: string) => formatDate(NOW, pattern, { offsetAt: UTC })
    expect(f('[Week of] YYYY')).toBe('Week of 2026')
    expect(f('[YYYY] YYYY')).toBe('YYYY 2026')
    expect(f('YYYY.MM.DD (x)')).toBe('2026.03.03 (x)')
    expect(f('')).toBe('')
  })

  it('writes the afternoon and midnight in twelve-hour time', () => {
    expect(formatDate(at('2026-03-03T15:30:00Z'), 'h:mm A', { offsetAt: UTC })).toBe('3:30 PM')
    expect(formatDate(at('2026-03-03T00:10:00Z'), 'h:mm a', { offsetAt: UTC })).toBe('12:10 am')
    expect(formatDate(at('2026-03-03T12:00:00Z'), 'h A', { offsetAt: UTC })).toBe('12 PM')
  })

  it('follows the zone: the date changes where the local day does', () => {
    // 2026-03-03 23:30 in Los Angeles (PST, -08:00) is already the 4th in UTC.
    const late = at('2026-03-04T07:30:00Z')
    expect(formatDate(late, 'YYYY-MM-DD HH:mm Z', { offsetAt: LA })).toBe('2026-03-03 23:30 -08:00')
    expect(formatDate(late, 'YYYY-MM-DD HH:mm Z', { offsetAt: SHANGHAI })).toBe(
      '2026-03-04 15:30 +08:00',
    )
    expect(formatDate(late, 'HH:mm Z', { offsetAt: KATHMANDU })).toBe('13:15 +05:45')
  })

  it('crosses daylight saving time in Los Angeles', () => {
    // 2026-03-08: clocks go from 02:00 PST to 03:00 PDT.
    expect(formatDate(at('2026-03-08T09:59:00Z'), 'HH:mm Z', { offsetAt: LA })).toBe('01:59 -08:00')
    expect(formatDate(at('2026-03-08T10:00:00Z'), 'HH:mm Z', { offsetAt: LA })).toBe('03:00 -07:00')
    // 2026-11-01: back from 02:00 PDT to 01:00 PST.
    expect(formatDate(at('2026-11-01T08:30:00Z'), 'HH:mm Z', { offsetAt: LA })).toBe('01:30 -07:00')
    expect(formatDate(at('2026-11-01T09:30:00Z'), 'HH:mm Z', { offsetAt: LA })).toBe('01:30 -08:00')
  })

  it('pads years before 1000', () => {
    expect(formatDate(Date.UTC(812, 0, 2), 'YYYY YY', { offsetAt: UTC })).toBe('0812 12')
  })
})

describe('expandTemplate', () => {
  const clock = { now: NOW, offsetAt: UTC }

  it('fills in the date, the time and the title, with their default formats', () => {
    expect(
      expandTemplate('{{date}} {{time}} {{datetime}} {{title}}', { ...clock, title: 'Plan' }),
    ).toBe('2026-03-03 09:05 2026-03-03 09:05 Plan')
  })

  it('takes a format after a colon', () => {
    expect(expandTemplate('{{date:dddd D MMMM YYYY}}', clock)).toBe('Tuesday 3 March 2026')
    expect(expandTemplate('{{time:h:mm A}}', clock)).toBe('9:05 AM')
    expect(expandTemplate('{{datetime:YYYYMMDD[T]HHmm}}', clock)).toBe('20260303T0905')
    expect(expandTemplate('{{date:}}', clock)).toBe('2026-03-03')
  })

  it('accepts spaces inside the braces and names in any case', () => {
    expect(expandTemplate('{{ date }} {{ Date : YYYY }} {{TIME}}', clock)).toBe(
      '2026-03-03 2026 09:05',
    )
  })

  it('leaves unknown variables, and malformed ones, as text', () => {
    const text = '{{author}} {{date:YYYY}x}} {date} {{}} {{ title:upper }} {{date\n}}'
    expect(expandTemplate(text, { ...clock, title: 'T' })).toBe(
      '{{author}} {{date:YYYY}x}} {date} {{}} {{ title:upper }} {{date\n}}',
    )
  })

  it('leaves {{title}} as text when no title is known', () => {
    expect(expandTemplate('# {{title}}', clock)).toBe('# {{title}}')
  })

  it('expands once: a title that holds a variable is not expanded again', () => {
    expect(expandTemplate('{{title}}', { ...clock, title: '{{date}}' })).toBe('{{date}}')
  })

  it('uses the injected zone', () => {
    const late = { now: at('2026-03-04T07:30:00Z') }
    expect(expandTemplate('{{date}} {{time}}', { ...late, offsetAt: LA })).toBe('2026-03-03 23:30')
    expect(expandTemplate('{{date}} {{time}}', { ...late, offsetAt: SHANGHAI })).toBe(
      '2026-03-04 15:30',
    )
  })
})

describe('withoutFrontMatterKeys', () => {
  it('drops the named keys, block lists included, and keeps the rest of the front matter', () => {
    const text =
      '---\ntitle: A\nauthor: me\ntags:\n  - one\n  - two\nStatus: active\nlang: en\n---\n# Body\n'
    expect(withoutFrontMatterKeys(text, ['title', 'tags', 'status'])).toBe(
      '---\nauthor: me\nlang: en\n---\n# Body\n',
    )
  })

  it('drops the whole front matter when nothing else is left in it', () => {
    expect(
      withoutFrontMatterKeys('---\ntitle: A\nnotebook: B\n---\n\n# Body\n', TEMPLATE_KEYS),
    ).toBe('# Body\n')
    expect(withoutFrontMatterKeys('---\ntags: [a]\n---', TEMPLATE_KEYS)).toBe('')
  })

  it('reads keys on lines that end in a carriage return', () => {
    expect(withoutFrontMatterKeys('---\r\ntitle: A\r\nlang: en\r\n---\r\nB', ['title'])).toBe(
      '---\r\nlang: en\r\n---\r\nB',
    )
    expect(withoutFrontMatterKeys('---\r\ntitle: A\r\n---\r\n\r\nB', ['title'])).toBe('B')
  })

  it('leaves a note without front matter, or without those keys, alone', () => {
    expect(withoutFrontMatterKeys('# Body\n\ntitle: x\n', TEMPLATE_KEYS)).toBe(
      '# Body\n\ntitle: x\n',
    )
    expect(withoutFrontMatterKeys('---\nauthor: me\n---\nText', TEMPLATE_KEYS)).toBe(
      '---\nauthor: me\n---\nText',
    )
    // An unclosed fence is a thematic break, not front matter.
    expect(withoutFrontMatterKeys('---\ntitle: A\n', TEMPLATE_KEYS)).toBe('---\ntitle: A\n')
  })
})

const book = (id: string, name: string, parentId: string | null = null): BookRecord => ({
  id,
  name,
  nameHlc: 'h',
  parentId,
  parentHlc: 'h',
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  deletedHlc: null,
  aiAccess: false,
  aiAccessHlc: '',
  icon: null,
  iconColor: null,
  iconHlc: '',
  sortKey: '',
  sortKeyHlc: '',
})

describe('resolveNotebook', () => {
  const books = [
    book('a', 'Work'),
    book('b', 'Meetings', 'a'),
    book('c', 'Home'),
    book('d', 'Meetings', 'c'),
    book('e', 'Résumé'),
  ]

  it('finds a notebook by name in any case, the first in sidebar order', () => {
    expect(resolveNotebook('work', books)).toBe('a')
    expect(resolveNotebook('  Home ', books)).toBe('c')
    expect(resolveNotebook('Meetings', books)).toBe('d')
  })

  it('finds a nested notebook by its path', () => {
    expect(resolveNotebook('Work/Meetings', books)).toBe('b')
    expect(resolveNotebook('home / meetings', books)).toBe('d')
  })

  it('tells accents apart, and finds nothing for an unknown name', () => {
    expect(resolveNotebook('resume', books)).toBeNull()
    expect(resolveNotebook('Résumé', books)).toBe('e')
    expect(resolveNotebook('Nowhere', books)).toBeNull()
    expect(resolveNotebook('Work/Nowhere', books)).toBeNull()
    expect(resolveNotebook('', books)).toBeNull()
    expect(resolveNotebook(null, books)).toBeNull()
  })
})

describe('draftFromTemplate', () => {
  const clock = { now: NOW, offsetAt: UTC }

  it('sets the defaults from front matter and keeps them out of the body', () => {
    const draft = draftFromTemplate(
      {
        title: 'Meeting template',
        body:
          '---\ntitle: Meeting {{date:YYYY-MM-DD}}\nnotebook: Work/Meetings\n' +
          'tags: [meeting, "{{date:YYYY}}"]\nstatus: Active\nattendees: []\n---\n' +
          '# {{title}}\n\nStarted at {{time}}. {{unknown}}\n',
      },
      clock,
    )
    expect(draft).toEqual({
      title: 'Meeting 2026-03-03',
      notebook: 'Work/Meetings',
      tags: ['meeting', '2026'],
      status: 'active',
      body: '---\nattendees: []\n---\n# Meeting 2026-03-03\n\nStarted at 09:05. {{unknown}}\n',
    })
  })

  it("uses the template's own title, expanded, when the front matter has none", () => {
    const draft = draftFromTemplate({ title: 'Daily {{date:D MMM}}', body: '# {{title}}\n' }, clock)
    expect(draft).toEqual({
      title: 'Daily 3 Mar',
      notebook: null,
      tags: [],
      status: null,
      body: '# Daily 3 Mar\n',
    })
  })

  it('keeps a title on one line and within the length a title may have', () => {
    const long = draftFromTemplate(
      { title: 'x', body: `---\ntitle: "${'a'.repeat(1200)}"\n---\n` },
      clock,
    )
    expect([...long.title]).toHaveLength(1000)
    expect(draftFromTemplate({ title: ' Two\tparts ', body: '' }, clock).title).toBe('Two parts')
    // An empty title key falls back to the template's title.
    expect(draftFromTemplate({ title: 'Own', body: '---\ntitle: ""\n---\n' }, clock).title).toBe(
      'Own',
    )
  })

  it('makes every line break a line feed, so the keys are found and dropped', () => {
    const draft = draftFromTemplate(
      { title: 'x', body: '---\r\ntitle: CRLF\r\ntags: a\r\nlang: en\r\n---\r\nBody\rmore\r\n' },
      clock,
    )
    expect(draft).toMatchObject({
      title: 'CRLF',
      tags: ['a'],
      body: '---\nlang: en\n---\nBody\nmore\n',
    })
  })

  it('reads the front matter as YAML: comments, escapes, block scalars and multi-line lists', () => {
    const draft = draftFromTemplate(
      {
        title: 'x',
        body:
          '---\ntitle: Weekly {{date:YYYY-MM-DD}} # fill in\nnotebook: Work/Meetings # where\n' +
          'tags: [\n  meeting,\n  "deep focus", # second\n]\nstatus: Active # now\nlang: en\n---\nBody\n',
      },
      clock,
    )
    expect(draft).toEqual({
      title: 'Weekly 2026-03-03',
      notebook: 'Work/Meetings',
      tags: ['meeting', 'deep focus'],
      status: 'active',
      body: '---\nlang: en\n---\nBody\n',
    })
    const empty = draftFromTemplate({ title: 'Own', body: '---\ntitle: ~\n---\n' }, clock)
    expect(empty.title).toBe('Own')
    expect(
      draftFromTemplate({ title: 'Own', body: '---\ntitle: >\n  Folded\n  title\n---\n' }, clock)
        .title,
    ).toBe('Folded title')
    expect(
      draftFromTemplate({ title: 'x', body: '---\ntitle: "A\\x41\\u00e9"\n---\n' }, clock).title,
    ).toBe('AA\u00e9')
  })

  it('leaves a {{title}} inside the title as text', () => {
    expect(draftFromTemplate({ title: 'Copy of {{title}}', body: '' }, clock).title).toBe(
      'Copy of {{title}}',
    )
  })
})

describe('excludeTemplates', () => {
  // The Rust store refuses a query with more conditions than this
  // (MAX_SEARCH_CONDITIONS in src-tauri/src/commands/notes.rs).
  const MAX_CONDITIONS = 12
  const books = [book(TEMPLATES_BOOK_ID, 'Templates'), book('w', 'Work'), book('h', 'Home')]
  const tags = [{ ...book('t', 'fruit'), color: null, colorHlc: '' }]
  const conditions = (q: NoteQuery) => q.text.length + q.sets.length
  const run = (query: string, scope?: SearchScope) =>
    excludeTemplates(resolveSearch(parseSearch(query), { books, tags, scope })!)

  it('adds a condition that leaves the Templates notebook out', () => {
    expect(run('kiwi').sets).toEqual([{ kind: 'book', ids: [TEMPLATES_BOOK_ID], negate: true }])
  })

  it('adds nothing when a notebook already narrows the query', () => {
    expect(run('kiwi book:Work').sets).toEqual([{ kind: 'book', ids: ['w'], negate: false }])
    expect(run('kiwi', { bookId: 'h', filter: null }).sets).toEqual([
      { kind: 'book', ids: ['h'], negate: false },
    ])
  })

  it('joins a notebook the query already leaves out', () => {
    expect(run('kiwi -book:Work').sets).toEqual([
      { kind: 'book', ids: ['w', TEMPLATES_BOOK_ID], negate: true },
    ])
  })

  it('never makes a query longer than storage accepts', () => {
    const ten = 'a b c d e f g h i j'
    const filter = { kind: 'tag', tagId: 't' } as const
    expect(conditions(run(ten, { bookId: null, filter }))).toBe(MAX_CONDITIONS)
    expect(conditions(run(ten, { bookId: 'w', filter }))).toBe(MAX_CONDITIONS)
    expect(
      conditions(run('a b c d e f g h i -book:Home', { bookId: null, filter })),
    ).toBeLessThanOrEqual(MAX_CONDITIONS)
  })
})

describe('excludeTemplates with Templates nested by an older Devot', () => {
  it('drops Templates from a notebook that narrows the query', () => {
    const books = [{ ...book(TEMPLATES_BOOK_ID, 'Templates'), parentId: 'w' }, book('w', 'Work')]
    const query = resolveSearch(parseSearch('book:Work'), { books, tags: [] })!
    expect(query.sets[0]?.ids.sort()).toEqual([TEMPLATES_BOOK_ID, 'w'].sort())
    expect(excludeTemplates(query).sets).toEqual([{ kind: 'book', ids: ['w'], negate: false }])
  })
})

describe('{{uuid}}', () => {
  const clock = { now: NOW, offsetAt: UTC }
  const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

  it('makes a distinct valid UUID v4 for each note, the same one inside a note', () => {
    const template = { title: 'T', body: 'id: {{uuid}} again {{UUID}}' }
    const a = draftFromTemplate(template, clock)
    const b = draftFromTemplate(template, clock)
    const [first, second] = [a, b].map((d) => /id: (\S+) again (\S+)/.exec(d.body)!)
    expect(first![1]).toMatch(V4)
    expect(first![2]).toBe(first![1])
    expect(second![1]).toMatch(V4)
    expect(second![1]).not.toBe(first![1])
  })
})

describe('instruction quotes', () => {
  const clock = { now: NOW, offsetAt: UTC }

  it('removes a quote whose first line is a ! heading, with its blank line', () => {
    const body = '> # !Instructions\n> Fill in the goal.\n\n# {{title}}\n\nText\n'
    expect(draftFromTemplate({ title: 'T', body }, clock).body).toBe('# T\n\nText\n')
  })

  it('keeps an ordinary quote, a quote heading without ! and a quote in a code block', () => {
    const body = '> # Notes\n> kept\n\n> plain quote\n\n```\n> # !Not removed\n```\n'
    expect(withoutInstructions(body)).toBe(body)
  })

  it('stays in the template itself: only the draft drops it', () => {
    const body = '> # !Instructions\n> Hi\n\nBody\n'
    expect(withoutInstructions(body)).toBe('Body\n')
    expect(STARTER_TEMPLATES.every((t) => t.body.includes('> # !Instructions'))).toBe(true)
  })
})

describe('starter templates', () => {
  it('are the five named ones, with IDs no stored note has, and leave no instructions in a note', () => {
    expect(STARTER_TEMPLATES.map((t) => t.title)).toEqual([
      'Brainstorming',
      'Debugging',
      'Learning',
      'Planning',
      'Daily Report',
    ])
    expect(STARTER_TEMPLATES.every((t) => isStarterTemplate(t.id))).toBe(true)
    const daily = STARTER_TEMPLATES.find((t) => t.title === 'Daily Report')!
    expect(daily.body).toContain('{{date}}')
    const made = draftFromTemplate(daily, { now: NOW, offsetAt: UTC })
    expect(made.title).toBe('Daily Report 2026-03-03')
    expect(made.body.trim().startsWith('# Daily Report 2026-03-03')).toBe(true)
    expect(made.body).not.toContain('!Instructions')
  })
})
