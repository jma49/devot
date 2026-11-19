import { expect, it, vi } from 'vitest'
import { createOpening } from './opening'

it.each(['switch', 'teardown', 'failure'])(
  'resets every pending opening resource on %s',
  async (exit) => {
    const opening = createOpening(32)
    const { request } = opening.begin('long', 'x'.repeat(40))
    const waiting = opening.waiting!
    const cancel = vi.fn<() => void>()
    opening.set('build', cancel)
    opening.set('commit', cancel)
    opening.set('advance', cancel)
    opening.warm(cancel)
    opening.select(waiting.done)
    opening.reset(exit === 'switch' ? 'blank' : undefined, exit === 'failure')
    expect(opening.phase).toBe(exit === 'failure' ? 'failed' : 'idle')
    expect(opening.current(request)).toBe(false)
    expect(opening.selection).toBeUndefined()
    expect(opening.waiting).toBeUndefined()
    expect(opening.has('build') || opening.has('commit') || opening.has('advance')).toBe(false)
    expect(cancel).toHaveBeenCalledTimes(4)
    await expect(waiting.done).resolves.toBe(false)
  },
)

it('keeps the head waiter through the full request and resolves it only on the full answer', async () => {
  const opening = createOpening(32)
  opening.begin('long', 'x'.repeat(40))
  const waiting = opening.waiting!
  opening.shown(true)
  opening.begin('long', 'x'.repeat(40), false)
  expect(opening.waiting).toBe(waiting)
  opening.shown(false)
  expect(opening.phase).toBe('full')
  await expect(waiting.done).resolves.toBe(true)
})

it('reserves the opening for a nonempty body and resets even across blank notes', () => {
  const opening = createOpening(32)
  opening.begin('long', '')
  opening.shown(false)
  expect(opening.begin('long', 'x'.repeat(40)).head).toBe(true)
  opening.shown(false)
  expect(opening.begin('long', 'x'.repeat(41)).head).toBe(false)
  opening.reset('blank')
  opening.begin('blank', '')
  opening.reset('long')
  expect(opening.begin('long', 'x'.repeat(40)).head).toBe(true)
})
