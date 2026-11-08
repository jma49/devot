// @vitest-environment happy-dom
import { act, useEffect, useRef, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NoteStatus, NoteSummary } from '../../core'
import type { ListSelection } from './listSelection'
import { NoteBoard } from './NoteBoard'
import { NoteGallery } from './NoteGallery'
import { NoteList } from './NoteList'
import { usePendingFocus } from './pendingFocus'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const note = (id: string, status: NoteStatus = 'active'): NoteSummary => ({
  id,
  title: `Note ${id}`,
  createdAt: 0,
  updatedAt: 0,
  bodyVersion: 1,
  bookId: null,
  status,
  pinned: false,
  tagIds: [],
})

const noop = () => undefined
const tags = new Map()
// The open note A was in the selection; it has left the view, and B and C stay selected.
const selection: ListSelection = { ids: ['b', 'c'], anchor: 'b', lead: 'c' }

let root: Root | undefined
let host: HTMLElement | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await act(async () => root?.unmount())
  host?.remove()
  document.body.innerHTML = ''
})

async function render(element: ReactElement) {
  if (!host) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  await act(async () => root!.render(element))
}

const card = (id: string) => document.querySelector<HTMLElement>(`[data-note-id="${id}"]`)!

/** Escape on C, the keyboard into an outside field, then A back in the view: the field keeps the keyboard. */
async function escapeThenType(show: (listed: boolean) => ReactElement) {
  host = undefined
  await render(show(false))
  const field = document.createElement('input')
  document.body.append(field)
  // The gallery measures its grid on a scroll (and on resizes, which this DOM does not report).
  await act(async () =>
    document.querySelector('.gallery-scroll')?.dispatchEvent(new Event('scroll')),
  )
  await act(async () => card('c').focus())
  await act(async () => {
    card('c').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await act(async () => field.focus())
  await render(show(true))
  return field
}

describe('a focus request for a note the view does not show', () => {
  it('is dropped by the list, so the row does not take the keyboard when the note comes back', async () => {
    const field = await escapeThenType((listed) => (
      <NoteList
        view="tag:t1"
        title="Tag"
        pinned={[]}
        notes={listed ? [note('a'), note('b'), note('c')] : [note('b'), note('c')]}
        tags={tags}
        selected="a"
        onSelect={noop}
        onCreate={undefined}
        selection={listed ? undefined : selection}
        onSelection={noop}
      />
    ))
    expect(document.activeElement).toBe(field)
  })

  it('is dropped by the board, so the card does not take the keyboard when its column shows', async () => {
    const statuses: NoteStatus[] = ['none', 'active', 'on_hold', 'completed']
    const field = await escapeThenType((listed) => (
      <NoteBoard
        view="all"
        title="All"
        onCreate={undefined}
        notes={[note('a', 'dropped'), note('b'), note('c')]}
        statuses={listed ? [...statuses, 'dropped'] : statuses}
        tags={tags}
        selected="a"
        onSelect={noop}
        selection={listed ? undefined : selection}
        onSelection={noop}
      />
    ))
    expect(document.activeElement).toBe(field)
  })

  it('is dropped by the gallery, so the card does not take the keyboard when the note comes back', async () => {
    // The grid lays out cards only once it has a width.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600)
    const field = await escapeThenType((listed) => (
      <NoteGallery
        view="tag:t1"
        title="Tag"
        onCreate={undefined}
        notes={listed ? [note('a'), note('b'), note('c')] : [note('b'), note('c')]}
        tags={tags}
        fittedWidth={600}
        selected="a"
        onSelect={noop}
        selection={listed ? undefined : selection}
        onSelection={noop}
        draggable
      />
    ))
    expect(document.activeElement).toBe(field)
  })
})

const asks: { request: (id: string) => void } = { request: noop }
let takes = 0
const ask = (id: string) => asks.request(id)

/**
 * A listbox that renders a note only while asked to focus it or focused, as a long list does with a row outside its window.
 * With `focusable` false, the note's element never takes the keyboard.
 */
function Rows(props: { view: string; ids: readonly string[]; focusable?: boolean }) {
  const box = useRef<HTMLUListElement>(null)
  const [focused, setFocused] = useState<string>()
  const pending = usePendingFocus({
    view: props.view,
    listed: (id) => props.ids.includes(id),
    element: (id) => box.current?.querySelector<HTMLElement>(`[data-note-id="${id}"]`) ?? undefined,
    container: () => box.current,
    take: (el) => {
      takes++
      if (props.focusable !== false) el.focus()
    },
  })
  useEffect(() => {
    asks.request = pending.request
  })
  return (
    <ul ref={box} role="listbox" tabIndex={-1}>
      {[...new Set([pending.revealed, focused])].map((id) =>
        id === undefined ? null : (
          <li key={id} data-note-id={id} tabIndex={-1} onFocus={() => setFocused(id)} />
        ),
      )}
    </ul>
  )
}

describe('a pending focus request', () => {
  const start = async () => {
    host = undefined
    takes = 0
    await render(<Rows view="all" ids={['a']} />)
  }

  it('gives the note the keyboard once it renders', async () => {
    await start()
    await act(async () => ask('a'))
    expect(document.activeElement).toBe(card('a'))
  })

  it('expires when the keyboard moves elsewhere before the note renders', async () => {
    await start()
    const field = document.createElement('input')
    document.body.append(field)
    await act(async () => {
      ask('a')
      field.focus()
    })
    expect(document.activeElement).toBe(field)
    expect(card('a')).toBeNull()
  })

  it('still waits while the keyboard is on the listbox itself', async () => {
    await start()
    await act(async () => {
      ask('a')
      document.querySelector<HTMLElement>('[role="listbox"]')!.focus()
    })
    expect(document.activeElement).toBe(card('a'))
  })

  it('expires when the view changes before the note renders', async () => {
    await start()
    await act(async () => {
      ask('a')
      root!.render(<Rows view="trash" ids={['a']} />)
    })
    expect(card('a')).toBeNull()
  })

  it('is dropped at once for a note the view does not list', async () => {
    await start()
    await act(async () => ask('z'))
    expect(card('z')).toBeNull()
  })

  it('tries the note once, so a note that does not take the keyboard is not tried on every render', async () => {
    await start()
    await act(async () => root!.render(<Rows view="all" ids={['a']} focusable={false} />))
    await act(async () => ask('a'))
    await act(async () => root!.render(<Rows view="all" ids={['a', 'b']} focusable={false} />))
    expect(takes).toBe(1)
  })
})
