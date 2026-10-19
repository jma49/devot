import { describe, expect, it } from 'vitest'
import { keptAnswers } from './kept'

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('keptAnswers', () => {
  it('asks once per key, sharing an answer still on its way', async () => {
    let asked = 0
    const kept = keptAnswers<string>(4, () => true)
    const ask = () => Promise.resolve(`answer ${(asked += 1)}`)
    const first = kept('a', ask)
    expect(kept('a', ask)).toBe(first)
    await settle()
    expect(await kept('a', ask)).toBe('answer 1')
    expect(await kept('b', ask)).toBe('answer 2')
    expect(asked).toBe(2)
  })

  it('asks again after an answer it does not keep, or a failure', async () => {
    let asked = 0
    const kept = keptAnswers<string>(4, (answer) => answer !== 'failed')
    void kept('a', () => Promise.resolve('failed'))
    kept('b', () => Promise.reject(new Error('E_TEST'))).catch(() => {})
    await settle()
    void kept('a', () => Promise.resolve(`again ${(asked += 1)}`))
    void kept('b', () => Promise.resolve(`again ${(asked += 1)}`))
    expect(asked).toBe(2)
  })

  it('forgets the answer used longest ago past its limit', () => {
    let asked = 0
    const kept = keptAnswers<number>(2, () => true)
    const ask = () => Promise.resolve((asked += 1))
    void kept('a', ask)
    void kept('b', ask)
    void kept('a', ask)
    void kept('c', ask)
    expect(asked).toBe(3)
    void kept('a', ask)
    expect(asked).toBe(3)
    void kept('b', ask)
    expect(asked).toBe(4)
  })
})
