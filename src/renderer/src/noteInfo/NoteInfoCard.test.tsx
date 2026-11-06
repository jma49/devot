// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NoteFacts } from '../../../core/noteFacts'
import { settle } from '../../../../tests/support/render-hook'
import { NoteInfoCard, type Backlink } from './NoteInfoCard'

vi.mock('../icons/Icon', () => ({ Icon: () => null }))

const info = {
  noteId: '0192a6f0-0000-7000-8000-00000000000a',
  createdAt: new Date(2026, 9, 13, 1, 43, 54).getTime(),
  updatedAt: new Date(2026, 10, 2, 9, 30, 12).getTime(),
}

const facts: NoteFacts = {
  tasks: { done: 1, total: 4 },
  words: 1284,
  frontMatter: {
    kind: 'properties',
    rows: [
      {
        key: 'status',
        value: { kind: 'text', text: 'on hold' },
        difference: { field: 'status', badge: 'Note: Active', value: 'on_hold' },
      },
      { key: 'tags', value: { kind: 'chips', chips: [{ name: 'work' }] } },
    ],
  },
}

let root: Root | undefined

afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.replaceChildren()
  localStorage.clear()
})

function show(props: Partial<Parameters<typeof NoteInfoCard>[0]> = {}) {
  const host = document.createElement('div')
  document.body.append(host)
  const calls = {
    close: vi.fn<() => void>(),
    open: vi.fn<(id: string) => void>(),
    dates: vi.fn<(id: string, dates: object) => Promise<void>>(() => Promise.resolve()),
    apply: vi.fn<(change: object) => void>(),
  }
  root = createRoot(host)
  act(() =>
    root!.render(
      <NoteInfoCard
        info={info}
        facts={facts}
        backlinks={[]}
        onOpenNote={calls.open}
        onSetDates={calls.dates}
        onApplyFrontMatter={calls.apply}
        onClose={calls.close}
        {...props}
      />,
    ),
  )
  return calls
}

const press = (key: string, target: Element | null = document.activeElement, extra = {}) =>
  act(() => {
    target?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...extra }))
  })

const click = (el: Element | null | undefined) =>
  act(() => {
    ;(el as HTMLElement).click()
  })

const button = (name: string | RegExp) =>
  Array.from(document.querySelectorAll('button')).find((b) => {
    const label = b.getAttribute('aria-label') ?? b.textContent ?? ''
    return typeof name === 'string' ? label === name : name.test(label)
  })

const focusedDay = () => document.activeElement?.getAttribute('aria-label')

describe('the Note Info card', () => {
  it('names each date and what a click does', () => {
    show()
    expect(button(/^Created: .*\. Change the date$/)).toBeDefined()
    expect(button(/^Updated: .*\. Change the date$/)).toBeDefined()
  })

  it('shows the dates as text when they cannot be changed', () => {
    show({ onSetDates: undefined, onApplyFrontMatter: undefined })
    expect(button(/Change the date/)).toBeUndefined()
    expect(document.querySelector('time[data-info="created"]')).not.toBeNull()
    expect(button('Apply status to note')).toBeUndefined()
  })

  it('closes on Escape', () => {
    const calls = show()
    press('Escape', document.querySelector('.note-info-card'))
    expect(calls.close).toHaveBeenCalledOnce()
  })

  it('lists the properties, and Apply sets the note’s field', () => {
    const calls = show()
    const rows = Array.from(document.querySelectorAll('.note-info-property'))
    expect(rows.map((r) => r.querySelector('dt')?.textContent)).toEqual(['status', 'tags'])
    expect(document.querySelector('.frontmatter-badge')?.textContent).toBe('Note: Active')
    click(button('Apply status to note'))
    expect(calls.apply).toHaveBeenCalledWith({ field: 'status', value: 'on_hold' })
  })

  it('folds a section and remembers it', () => {
    show()
    const caption = button(/^Properties/)
    expect(caption?.getAttribute('aria-expanded')).toBe('true')
    click(caption)
    expect(document.querySelector('.note-info-properties')).toBeNull()
    act(() => root?.unmount())
    show()
    expect(document.querySelector('.note-info-properties')).toBeNull()
  })

  it('says when no note links here, and opens one that does', () => {
    show()
    expect(document.querySelector('.note-info-empty')?.textContent).toBe('No notes link here yet')
    act(() => root?.unmount())
    const links: Backlink[] = [{ id: 'b', name: 'Plan' }]
    const calls = show({ backlinks: links })
    click(button('Plan'))
    expect(calls.open).toHaveBeenCalledWith('b')
    expect(calls.close).toHaveBeenCalled()
  })

  it('shows the tasks and the words in its foot', () => {
    show()
    const foot = document.querySelector('.note-info-foot')
    expect(foot?.querySelector('progress')?.getAttribute('aria-label')).toBe('1 of 4 tasks')
    expect(foot?.textContent).toContain('1/4')
    expect(foot?.textContent).toContain('1,284')
  })
})

describe('the date picker', () => {
  const openCreated = () => {
    const calls = show()
    click(button(/^Created:/))
    return calls
  }

  it('opens on the date, with the day focused as the grid’s one tab stop', () => {
    openCreated()
    expect(document.querySelector('.date-picker')).not.toBeNull()
    expect(focusedDay()).toBe('Tuesday, October 13, 2026')
    expect(document.querySelectorAll('.date-picker [role="gridcell"][tabindex="0"]')).toHaveLength(
      1,
    )
    expect(document.querySelector('.date-picker-month')?.textContent).toBe('October 2026')
  })

  it('moves the day with the arrows, the month with Page Up and Page Down, and goes to today with T', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 9, 20, 12) })
    try {
      openCreated()
      press('ArrowRight')
      expect(focusedDay()).toBe('Wednesday, October 14, 2026')
      press('ArrowDown')
      expect(focusedDay()).toBe('Wednesday, October 21, 2026')
      press('PageUp')
      expect(focusedDay()).toBe('Monday, September 21, 2026')
      expect(document.querySelector('.date-picker-days')?.getAttribute('data-slide')).toBe(
        'previous',
      )
      press('t')
      expect(focusedDay()).toBe('Tuesday, October 20, 2026')
    } finally {
      vi.useRealTimers()
    }
  })

  it('sets the date on Return, keeping the time and its seconds', async () => {
    const calls = openCreated()
    press('ArrowLeft')
    press('Enter')
    await settle()
    expect(calls.dates).toHaveBeenCalledWith(info.noteId, {
      createdAt: new Date(2026, 9, 12, 1, 43, 54).getTime(),
    })
    expect(document.querySelector('.date-picker')).toBeNull()
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Created:/)
  })

  it('turns off the days after Updated and refuses a time after it', () => {
    const calls = show()
    click(button(/^Created:/))
    for (let i = 0; i < 20; i++) press('ArrowRight')
    expect(focusedDay()).toBe('Monday, November 2, 2026')
    const hour = document.querySelector<HTMLElement>('[role="spinbutton"][aria-label="Hour"]')
    act(() => hour?.focus())
    // 1:43 to 10:43, later than Updated's 9:30.
    for (let i = 0; i < 9; i++) press('ArrowUp')
    const set = button('Set')
    expect(set?.getAttribute('aria-disabled')).toBe('true')
    expect(document.querySelector('.date-picker-note')?.textContent).toBe(
      'Created cannot be later than Updated.',
    )
    click(set)
    expect(calls.dates).not.toHaveBeenCalled()
    press('ArrowRight', document.querySelector('[role="gridcell"][tabindex="0"]'))
    expect(
      document
        .querySelector('[aria-label="Tuesday, November 3, 2026"]')
        ?.getAttribute('aria-disabled'),
    ).toBe('true')
  })

  it('cancels on Escape and leaves the card open', () => {
    const calls = openCreated()
    press('ArrowLeft')
    press('Escape')
    expect(document.querySelector('.date-picker')).toBeNull()
    expect(calls.close).not.toHaveBeenCalled()
    expect(calls.dates).not.toHaveBeenCalled()
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Created:/)
  })

  it('closes only the picker on the first click outside', () => {
    const calls = openCreated()
    act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(document.querySelector('.date-picker')).toBeNull()
    expect(calls.close).not.toHaveBeenCalled()
    act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(calls.close).toHaveBeenCalledOnce()
  })

  it('closes the picker when its own row is clicked again', () => {
    openCreated()
    const row = button(/^Created:/)!
    act(() => row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    click(row)
    expect(document.querySelector('.date-picker')).toBeNull()
    expect(row.getAttribute('aria-expanded')).toBe('false')
  })

  it('takes typed minutes and says when the date could not be saved', async () => {
    show({ onSetDates: vi.fn<() => Promise<void>>(() => Promise.reject(new Error('E_X'))) })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    click(button(/^Updated:/))
    const minute = document.querySelector<HTMLElement>('[role="spinbutton"][aria-label="Minute"]')
    act(() => minute?.focus())
    press('4')
    press('5')
    expect(minute?.textContent).toBe('45')
    press('Enter')
    await settle()
    expect(document.querySelector('.date-picker-note')?.textContent).toBe(
      'The date could not be saved.',
    )
    expect(warn).toHaveBeenCalledWith('W_NOTE_DATES_FAILED', info.noteId)
    warn.mockRestore()
  })
})
