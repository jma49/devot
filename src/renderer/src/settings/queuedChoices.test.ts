import { expect, it } from 'vitest'
import { createQueuedChoices } from './queuedChoices'

type Pair = { on: boolean; port: number }

function setUp(held: Pair) {
  const sent: Pair[] = []
  const answers: ((refused?: string) => void)[] = []
  const refusals: unknown[] = []
  const choices = createQueuedChoices<Pair>(
    (pair) => {
      sent.push(pair)
      return new Promise((resolve, reject) =>
        answers.push((refused) => (refused ? reject(new Error(refused)) : resolve(pair))),
      )
    },
    (e) => refusals.push(e),
  )
  choices.reading()(held)
  const answer = async (refused?: string) => {
    await Promise.resolve()
    answers.shift()?.(refused)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return { choices, sent, refusals, answer }
}

it('ignores a read that began before a save answered, even when it answers after', async () => {
  const { choices, sent, answer } = setUp({ on: false, port: 1 })
  choices.change({ on: true })
  const take = choices.reading()
  await answer()
  expect(take({ on: false, port: 1 })).toBe(false)
  choices.change({ port: 2 })
  await answer()
  expect(sent.at(-1)).toEqual({ on: true, port: 2 })
  expect(choices.reading()({ on: true, port: 3 })).toBe(true)
})

it('sends one save for changes queued behind the same one', async () => {
  const { choices, sent, answer } = setUp({ on: false, port: 1 })
  choices.change({ on: true })
  await Promise.resolve()
  choices.change({ port: 2 })
  choices.change({ port: 3 })
  await answer()
  await answer()
  await answer()
  expect(sent).toEqual([
    { on: true, port: 1 },
    { on: true, port: 3 },
  ])
})

it('starts again from what Rust holds after a refusal', async () => {
  const { choices, sent, refusals, answer } = setUp({ on: false, port: 1 })
  choices.change({ on: true })
  await answer('E_REFUSED')
  expect(refusals).toHaveLength(1)
  choices.change({ port: 2 })
  await answer()
  expect(sent.at(-1)).toEqual({ on: false, port: 2 })
})
