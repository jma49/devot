import { describe, expect, it } from 'vitest'
import { RateLimiter } from '../../relay/src/limiter'

type Step = [key: string, at: number]

const run = (limiter: RateLimiter, steps: Step[]) => steps.map(([key, at]) => limiter.take(key, at))

const EXPECTED = [0, 0, 0, 1000, 0, 500, 0, 0, 0, 0, 0, 0, 1000, 400, 0, 0, 0, 0, 0, 0]

const SEQUENCE: Step[] = [
  ['a', 0],
  ['a', 0],
  ['a', 0],
  ['a', 0],
  ['b', 100],
  ['a', 500],
  ['a', 1000],
  ['b', 1500],
  ['a', 2500],
  ['c', 2600],
  ['c', 2600],
  ['c', 2600],
  ['c', 2600],
  ['a', 2600],
  ['b', 9000],
  ['a', 9000],
  ['a', 8000],
  ['a', 9000],
  ['c', 20000],
  ['a', 20000],
]

describe('RateLimiter', () => {
  it('returns the same waits for a fixed sequence of takes', () => {
    expect(run(new RateLimiter(3, 1), SEQUENCE)).toEqual(EXPECTED)
  })

  it('forgets buckets that have refilled', () => {
    const limiter = new RateLimiter(3, 1)
    for (let i = 0; i < 500; i++) limiter.take(`ip-${i}`, i)
    expect(limiter.size).toBeGreaterThan(0)
    limiter.take('late', 10_000)
    limiter.take('later', 20_000)
    expect(limiter.size).toBeLessThanOrEqual(2)
  })

  it('keeps a short bucket across a sweep and still limits it', () => {
    const limiter = new RateLimiter(3, 1)
    for (let i = 0; i < 3; i++) expect(limiter.take('busy', 2000)).toBe(0)
    limiter.take('other', 0)
    limiter.take('x', 3500)
    expect(limiter.size).toBe(2)
    expect(limiter.take('busy', 3500)).toBe(0)
    expect(limiter.take('busy', 3500)).toBe(500)
  })
})
