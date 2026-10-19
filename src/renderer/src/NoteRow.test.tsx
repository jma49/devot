import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { NoteSummary, TagRecord } from '../../core'
import { NoteRow, parseProgress, type RowEvents, type RowProps } from './NoteRow'

const events: RowEvents = {
  setRow: () => {},
  mouseDown: () => {},
  click: () => {},
  dragStart: () => {},
  keyDown: () => {},
  contextMenu: () => {},
}

const now = Date.UTC(2026, 9, 10, 12)

function note(over: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id: 'n1',
    title: 'Garden plan',
    createdAt: now - 60_000,
    updatedAt: now - 7 * 60_000,
    bookId: null,
    status: 'none',
    pinned: false,
    tagIds: [],
    ...over,
  }
}

function row(over: Partial<RowProps> = {}): string {
  const props: RowProps = {
    note: note(),
    position: undefined,
    setSize: undefined,
    selected: false,
    open: false,
    tabbable: true,
    tags: new Map<string, TagRecord>(),
    highlight: undefined,
    headline: undefined,
    preview: undefined,
    progress: undefined,
    now,
    locale: 'en',
    dates: 'relative',
    draggable: true,
    dragging: false,
    menu: true,
    events,
    ...over,
  }
  return renderToStaticMarkup(<NoteRow {...props} />)
}

describe('NoteRow', () => {
  it('shows how long ago, or the date, by the dates style', () => {
    expect(row()).toContain('>7 minutes</time>')
    expect(row({ dates: 'absolute' })).toMatch(/>\d{1,2}:\d{2}[^<]*<\/time>/)
    expect(row({ dates: 'absolute', note: note({ updatedAt: now - 3 * 86_400_000 }) })).toContain(
      '>Oct 7, 2026</time>',
    )
  })

  it('marks the open note, which gets the focus bar while the list has the keyboard', () => {
    expect(row({ open: true, selected: true })).toContain('data-open="true"')
    expect(row({ open: false, selected: true })).not.toContain('data-open')
    expect(row({ selected: true })).toContain('aria-selected="true"')
  })

  it('shows the title, the time since the change and one line of body', () => {
    const html = row({ preview: 'tomato rows and beans' })
    expect(html).toContain('<span class="row-title">Garden plan</span>')
    expect(html).toContain('7 minutes</time>')
    expect(html).toContain('<span class="row-excerpt">tomato rows and beans</span>')
  })

  it('has no title node for a note without a title: its first line leads the excerpt', () => {
    const html = row({ note: note({ title: '' }), headline: 'Shopping list', preview: 'milk' })
    expect(html).not.toContain('row-title')
    expect(html).toContain('<span class="row-headline">Shopping list</span> milk')
  })

  it('shows task progress as "1 of 4" with a bar, only when the note has tasks', () => {
    const html = row({ progress: '1/4' })
    expect(html).toContain('<span class="progress-text" aria-hidden="true">1 of 4</span>')
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('aria-valuenow="1"')
    expect(html).toContain('style="transform:scaleX(0.25)"')
    expect(row({ progress: '' })).not.toContain('row-progress')
  })

  it('draws a coloured tag as a chip in its tag colour, and a plain tag as a plain chip', () => {
    const tag = (id: string, color: TagRecord['color']) =>
      ({ id, name: id, color }) as unknown as TagRecord
    const tags = new Map([
      ['t1', tag('t1', 'green')],
      ['t2', tag('t2', null)],
    ])
    const html = row({ note: note({ tagIds: ['t1', 't2'] }), tags })
    expect(html).toContain('<span class="chip tag-chip tag-color-green">')
    expect(html).toMatch(/<span class="chip">t2<\/span>/)
  })

  it('dims a row while it is being dragged', () => {
    expect(row({ dragging: true })).toMatch(/^<li class="row"[^>]* data-dragging="true"/)
    expect(row()).not.toContain('data-dragging')
  })

  it('shows the status as an icon with an accessible name, and no text', () => {
    const html = row({ note: note({ status: 'active' }) })
    expect(html).toMatch(
      /<span class="row-status status-active" role="img" aria-label="Active"[^>]*><span class="icon/,
    )
    expect(html).not.toMatch(/row-status[^>]*>Active</)
    expect(row()).not.toContain('row-status')
  })
})

describe('parseProgress', () => {
  it('reads "done/total" and refuses anything else', () => {
    expect(parseProgress('3/5')).toEqual({ done: 3, total: 5 })
    expect(parseProgress('')).toBeUndefined()
    expect(parseProgress('0/0')).toBeUndefined()
    expect(parseProgress('6/5')).toBeUndefined()
  })
})
