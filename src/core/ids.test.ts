import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createIdGenerator, UUID_V7 } from './ids'

describe('note IDs', () => {
  it('are canonical lowercase UUIDv7 strings', () => {
    const next = createIdGenerator()
    for (let i = 0; i < 100; i += 1) expect(next()).toMatch(UUID_V7)
  })

  it('encode the creation time in the first 48 bits', () => {
    const next = createIdGenerator({ now: () => 0x0192a6f00000 })
    expect(next().startsWith('0192a6f0-0000-7')).toBe(true)
  })

  it('strictly increase even when the clock stalls or goes backwards', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 2 ** 40 }), { minLength: 2, maxLength: 200 }),
        (times) => {
          let i = 0
          const next = createIdGenerator({ now: () => times[i++ % times.length] ?? 0 })
          const ids = times.map(() => next())
          for (let k = 1; k < ids.length; k += 1) expect(ids[k]! > ids[k - 1]!).toBe(true)
        },
      ),
    )
  })

  it('stay unique across 10k IDs in one millisecond', () => {
    const next = createIdGenerator({ now: () => 1_700_000_000_000 })
    expect(new Set(Array.from({ length: 10_000 }, next)).size).toBe(10_000)
  })
})
