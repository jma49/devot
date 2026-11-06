// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { noteFacts } from '../../../core/noteFacts'
import { settle } from '../../../../tests/support/render-hook'
import type { Core } from '../core-client'
import { requestNoteInfo } from './command'
import { NoteInfoSummary } from './NoteInfoSummary'

vi.hoisted(() => vi.stubGlobal('DEVOT_UI_TEST', true))
vi.mock('../icons/Icon', () => ({ Icon: () => null }))

const info = {
  noteId: '0192a6f0-0000-7000-8000-00000000000a',
  createdAt: new Date(2026, 9, 13, 1, 43, 54).getTime(),
  updatedAt: Date.now() - 5 * 60_000,
}

// The worker's calls, run here: the summary counts what the core counts.
const core = {
  noteFacts: (markdown: string) => Promise.resolve(noteFacts(markdown, undefined, 'Untitled')),
  backlinks: vi.fn<(id: string) => Promise<{ id: string; title: string }[]>>(() =>
    Promise.resolve([{ id: 'b', title: 'Plan' }]),
  ),
  headlines: () => Promise.resolve({}),
} as unknown as Core

let root: Root | undefined

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})

afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

async function show(markdown: string) {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root!.render(
      <NoteInfoSummary core={core} info={info} markdown={markdown} onOpenNote={() => {}} />,
    ),
  )
  await settle()
  await settle()
  return host.querySelector<HTMLButtonElement>('.note-summary')!
}

describe('the note summary', () => {
  it('lists what the note has, and says it opens Note Info', async () => {
    const summary = await show('---\ntitle: Plan\nauthor: me\n---\n\n- [x] done\n- [ ] two words\n')
    expect(summary.textContent).toBe('1/2 · 2 properties · 1 backlink · 3 words')
    expect(summary.getAttribute('aria-label')).toBe(`Note info: ${summary.textContent}`)
    expect(summary.getAttribute('aria-expanded')).toBe('false')
  })

  it('opens the card with the keyboard in it, and Escape gives the keyboard back', async () => {
    const summary = await show('Some words here')
    act(() => summary.click())
    const card = document.querySelector('.note-info-card')
    expect(summary.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(card)
    act(() => {
      card?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.querySelector('.note-info-card')).toBeNull()
    expect(document.activeElement).toBe(summary)
  })

  it('closes when the summary is clicked again', async () => {
    const summary = await show('Some words here')
    act(() => summary.click())
    act(() => summary.click())
    expect(document.querySelector('.note-info-card')).toBeNull()
  })

  it('opens and closes from View > Note Info, once for a key that reaches the menu too', async () => {
    const summary = await show('Some words here')
    act(() => requestNoteInfo())
    expect(document.querySelector('.note-info-card')).not.toBeNull()
    // The menu item's echo of the same key press.
    act(() => {
      window.dispatchEvent(new CustomEvent('devot:note-info'))
    })
    expect(document.querySelector('.note-info-card')).not.toBeNull()
    act(() => requestNoteInfo())
    expect(document.querySelector('.note-info-card')).toBeNull()
    expect(document.activeElement).toBe(summary)
  })

  it('asks for the backlinks again as the card opens', async () => {
    const summary = await show('Some words here')
    const asked = vi.mocked(core.backlinks).mock.calls.length
    act(() => summary.click())
    await settle()
    expect(vi.mocked(core.backlinks).mock.calls.length).toBe(asked + 1)
  })
})
