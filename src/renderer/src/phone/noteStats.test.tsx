// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { renderHook, unmountAll } from '../../../../tests/support/render-hook'
import { noteCounts } from '../../../core/noteCounts'
import { COUNTS_DEBOUNCE_MS } from '../editor/counts'
import { useNoteStats } from './noteStats'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  unmountAll()
  vi.useRealTimers()
})

const settle = () => act(() => vi.advanceTimersByTimeAsync(COUNTS_DEBOUNCE_MS))

it('counts through the given counter, not in render, and shows the last value meanwhile', async () => {
  const count = vi.fn<(markdown: string) => Promise<ReturnType<typeof noteCounts>>>(
    async (markdown) => noteCounts(markdown),
  )
  const hook = renderHook((text: string) => useNoteStats('n', text, count), {
    props: 'one two',
  })
  expect(count).not.toHaveBeenCalled()
  await settle()
  expect(hook.current).toEqual({ words: 2, characters: 6, readingMinutes: 1 })
  for (const text of ['one two t', 'one two th', 'one two thr', 'one two thre', 'one two three']) {
    hook.rerender(text)
    await act(() => vi.advanceTimersByTimeAsync(COUNTS_DEBOUNCE_MS - 1))
  }
  expect(hook.current.words).toBe(2)
  expect(count).toHaveBeenCalledTimes(1)
  await settle()
  expect(count).toHaveBeenCalledTimes(2)
  expect(hook.current).toEqual({ words: 3, characters: 11, readingMinutes: 1 })
})

it('drops a count that arrives after a newer text', async () => {
  const slow = new Map<string, (c: ReturnType<typeof noteCounts>) => void>()
  const count = (markdown: string) =>
    new Promise<ReturnType<typeof noteCounts>>((resolve) => slow.set(markdown, resolve))
  const hook = renderHook((text: string) => useNoteStats('n', text, count), {
    props: 'a',
  })
  await settle()
  hook.rerender('a b')
  await settle()
  await act(async () => slow.get('a b')?.(noteCounts('a b')))
  await act(async () => slow.get('a')?.(noteCounts('a')))
  expect(hook.current.words).toBe(2)
})

it('shows no counts from another note after the note changes', async () => {
  const count = async (markdown: string) => noteCounts(markdown)
  const hook = renderHook((p: { id: string; text: string }) => useNoteStats(p.id, p.text, count), {
    props: { id: 'a', text: 'one two three' },
  })
  await settle()
  expect(hook.current.words).toBe(3)
  hook.rerender({ id: 'b', text: '' })
  expect(hook.current.words).toBe(0)
  hook.rerender({ id: 'b', text: 'x y' })
  await settle()
  expect(hook.current.words).toBe(2)
})

it('logs a code and keeps the last counts when counting fails', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const count = async () => {
    throw new Error('secret note text')
  }
  const hook = renderHook((text: string) => useNoteStats('n', text, count), { props: 'a b' })
  await settle()
  expect(warn).toHaveBeenCalledWith('W_COUNTS_FAILED')
  expect(hook.current.words).toBe(0)
  warn.mockRestore()
})
