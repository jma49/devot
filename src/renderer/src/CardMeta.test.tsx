import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { NoteSummary, TagRecord } from '../../core'
import { CardMeta, type CardMetaProps } from './CardMeta'

const now = Date.UTC(2026, 9, 10, 12)

function note(over: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id: 'n1',
    title: 'Garden plan',
    createdAt: now - 60_000,
    updatedAt: now - 7 * 60_000,
    bodyVersion: 1,
    bookId: null,
    status: 'none',
    pinned: false,
    tagIds: [],
    ...over,
  }
}

const tag = (id: string, name: string, color: TagRecord['color']): TagRecord =>
  ({ id, name, color }) as TagRecord

const tags = new Map([
  ['t1', tag('t1', 'zebra', 'blue')],
  ['t2', tag('t2', 'apple', null)],
])

function meta(over: Partial<CardMetaProps> = {}): string {
  return renderToStaticMarkup(
    <CardMeta
      note={note()}
      tags={tags}
      now={now}
      locale="en"
      dates="relative"
      changedBy={undefined}
      marks={false}
      {...over}
    />,
  )
}

const order = (html: string, ...parts: string[]) =>
  parts.map((p) => html.indexOf(p)).every((at, i, all) => at >= 0 && (i === 0 || at > all[i - 1]!))

describe('CardMeta', () => {
  it('shows when the note changed', () => {
    expect(meta()).toContain('>7 min ago</time>')
  })

  it('ends with a dot per tag, by name, and names them for assistive technology', () => {
    const html = meta({ note: note({ tagIds: ['t1', 't2'] }) })
    expect(html.match(/class="tag-dot/g)).toHaveLength(2)
    expect(
      order(html, '</time>', 'card-tags', 'tag-dot tag-dot-plain', 'tag-dot tag-color-blue'),
    ).toBe(true)
    expect(html).toContain('Tags: apple, zebra')
  })

  it('leaves the tags out when the note has none, or only tags that are gone', () => {
    expect(meta()).not.toContain('card-tags')
    expect(meta({ note: note({ tagIds: ['gone'] }) })).not.toContain('card-tags')
  })

  it('on a board card shows no pin and no status mark: the column says the status', () => {
    const html = meta({ note: note({ pinned: true, status: 'active' }) })
    expect(html).not.toContain('card-pin')
    expect(html).not.toContain('card-status')
  })

  it('in a gallery caption leads with the pin and the status mark, then the time', () => {
    const html = meta({ marks: true, note: note({ pinned: true, status: 'on_hold' }) })
    expect(order(html, 'card-pin', 'card-status status-on_hold', '<time')).toBe(true)
    expect(html).toContain('aria-label="Pinned"')
    expect(html).toContain('aria-label="On Hold"')
  })

  it('in a gallery caption draws no mark for a note without a status or a pin', () => {
    const html = meta({ marks: true })
    expect(html).not.toContain('card-pin')
    expect(html).not.toContain('card-status')
  })

  it('shows who changed the note when an agent did', () => {
    const html = meta({ changedBy: { kind: 'mcp', name: 'Helper' } })
    expect(html).toContain('row-agent')
  })

  it('shows task progress as a ring and its count after the time, named for assistive technology', () => {
    const html = meta({ note: note({ tagIds: ['t1'] }), tasks: { done: 2, total: 5 } })
    expect(order(html, '</time>', 'card-tasks', '2/5', 'card-tags')).toBe(true)
    expect(html).toContain('aria-label="2 of 5 tasks done"')
    expect(html.match(/<circle/g)).toHaveLength(2)
    expect(html).not.toContain('card-tasks-done')
  })

  it('draws a complete ring once every task is done', () => {
    const html = meta({ tasks: { done: 9, total: 9 } })
    expect(html).toContain('card-tasks card-tasks-done')
    expect(html).toContain('9/9')
  })

  it('draws only the track while no task is done', () => {
    const html = meta({ tasks: { done: 0, total: 3 } })
    expect(html).toContain('0/3')
    expect(html.match(/<circle/g)).toHaveLength(1)
  })

  it('shows no task progress for a note without tasks, or before its counts are read', () => {
    expect(meta({ tasks: { done: 0, total: 0 } })).not.toContain('card-tasks')
    expect(meta({ tasks: undefined })).not.toContain('card-tasks')
  })
})
