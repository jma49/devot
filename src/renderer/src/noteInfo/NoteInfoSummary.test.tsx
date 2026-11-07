// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorState } from '@codemirror/state'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { noteCounts, type NoteCounts } from '../../../core/noteCounts'
import { noteFrontMatter, noteTally, type NoteTally } from '../../../core/noteFacts'
import { settle } from '../../../../tests/support/render-hook'
import type { Core } from '../core-client'
import { COUNTS_DEBOUNCE_MS, CountsPacer, type EditorCounts } from '../editor/counts'
import { tallyNote } from '../noteTally'
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
  noteTally: vi.fn<(markdown: string) => Promise<NoteTally>>((markdown) =>
    Promise.resolve(noteTally(markdown)),
  ),
  noteCounts: vi.fn<(markdown: string) => Promise<NoteCounts>>((markdown) =>
    Promise.resolve(noteCounts(markdown)),
  ),
  noteFrontMatter: (head: string) => Promise.resolve(noteFrontMatter(head, undefined, 'Untitled')),
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

const render = (markdown: string) =>
  act(() =>
    root!.render(
      <NoteInfoSummary core={core} info={info} markdown={markdown} onOpenNote={() => {}} />,
    ),
  )

async function show(markdown: string) {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  render(markdown)
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

  it('counts the note once a pause for itself and the counts footer', async () => {
    let state = EditorState.create({ doc: 'one two' })
    const reports: EditorCounts[] = []
    const pacer = new CountsPacer(
      () => state,
      (counts) => reports.push(counts),
      () => true,
      (markdown) => core.noteCounts(markdown),
      (markdown) => tallyNote(core, markdown),
    )
    vi.mocked(core.noteTally).mockClear()
    const summary = await show('one two')
    await vi.waitFor(() => expect(reports).toHaveLength(1))
    expect(core.noteTally).toHaveBeenCalledTimes(1)

    state = state.update({ changes: { from: 7, insert: ' three' } }).state
    pacer.changed(true)
    render(state.doc.toString())
    await vi.waitFor(() => expect(reports).toHaveLength(2), { timeout: 4 * COUNTS_DEBOUNCE_MS })
    await vi.waitFor(() => expect(summary.textContent).toBe('1 backlink \u00b7 3 words'))
    pacer.stop()
    expect(core.noteTally).toHaveBeenCalledTimes(2)
    expect(core.noteCounts).not.toHaveBeenCalled()
    expect(reports).toEqual([
      { words: 2, characters: 6, selection: null },
      { words: 3, characters: 11, selection: null },
    ])
  })
})
