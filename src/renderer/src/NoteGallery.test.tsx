// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { NoteSummary, TagRecord, TaskProgress } from '../../core'
import { GalleryCard } from './NoteGallery'

const now = Date.UTC(2026, 9, 10, 12)

const note: NoteSummary = {
  id: 'n1',
  title: 'Garden plan',
  createdAt: now - 60_000,
  updatedAt: now - 7 * 60_000,
  bodyVersion: 1,
  bookId: null,
  status: 'active',
  pinned: true,
  tagIds: ['t1'],
}

const tags = new Map([['t1', { id: 't1', name: 'home', color: 'blue' } as TagRecord]])

const noop = () => {}
const events = {
  setCard: () => noop,
  click: noop,
  dragStart: noop,
  keyDown: noop,
  contextMenu: noop,
}

function option(
  over: Partial<NoteSummary> = {},
  headline?: string,
  tasks?: TaskProgress,
): HTMLElement {
  document.body.innerHTML = renderToStaticMarkup(
    <ul>
      <GalleryCard
        note={{ ...note, ...over }}
        start={0}
        top={0}
        position={1}
        setSize={1}
        selected={false}
        tabbable
        tags={tags}
        changedBy={undefined}
        headline={headline}
        tasks={tasks}
        preview={undefined}
        draggable
        dragging={false}
        menu={false}
        now={now}
        locale="en"
        dates="relative"
        events={events}
      />
    </ul>,
  )
  return document.querySelector<HTMLElement>('[role="option"]')!
}

/** The option's name from its content: its text, without what is hidden from assistive technology, and image labels. */
function nameFromContent(el: Element): string {
  if (el.getAttribute('aria-hidden') === 'true') return ''
  if (el.getAttribute('role') === 'img') return ` ${el.getAttribute('aria-label') ?? ''} `
  return [...el.childNodes]
    .map((child) => (child instanceof Element ? nameFromContent(child) : (child.textContent ?? '')))
    .join(' ')
}

const spoken = (el: Element) => nameFromContent(el).replace(/\s+/g, ' ').trim()

describe('a gallery card for assistive technology', () => {
  it('is named by its content, so the caption is read, not only the title', () => {
    expect(option().hasAttribute('aria-label')).toBe(false)
  })

  it('reads the title first, then the pin, the status, the time and the tags, once each', () => {
    expect(spoken(option())).toBe('Garden plan Pinned Active 7 min ago Tags: home')
  })

  it('reads the task progress after the time', () => {
    expect(spoken(option({}, undefined, { done: 3, total: 8 }))).toBe(
      'Garden plan Pinned Active 7 min ago 3 of 8 tasks done Tags: home',
    )
  })

  it('reads the headline for a note without a title', () => {
    expect(spoken(option({ title: '' }, 'First line'))).toMatch(/^First line /)
  })
})
