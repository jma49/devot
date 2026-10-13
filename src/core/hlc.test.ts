import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { compareHlc, createClock, formatHlc, newNodeId, parseHlc, receiveStored } from './hlc'

describe('hybrid logical clock', () => {
  it('formats and parses round-trip', () => {
    const hlc = { wall: 1_728_000_000_000, counter: 42, node: 'mac1' }
    expect(parseHlc(formatHlc(hlc))).toEqual(hlc)
    expect(formatHlc(hlc)).toBe('0001728000000000-002a-mac1')
  })

  it('makes a new node ID every time, one a clock takes', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newNodeId()))
    expect(ids.size).toBe(200)
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{16}$/)
      expect(parseHlc(createClock(id).tick()).node).toBe(id)
    }
  })

  it('rejects malformed timestamps and node IDs', () => {
    expect(() => parseHlc('nope')).toThrow('E_HLC_INVALID')
    expect(() => createClock('Has Space')).toThrow('E_HLC_NODE_INVALID')
  })

  it('ticks strictly increase whatever the physical clock does', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 2 ** 42 }), { minLength: 1, maxLength: 300 }),
        (times) => {
          let i = 0
          const clock = createClock('a', () => times[i++] ?? 0)
          const stamps = times.map(() => clock.tick())
          for (let k = 1; k < stamps.length; k += 1)
            expect(compareHlc(stamps[k]!, stamps[k - 1]!)).toBe(1)
        },
      ),
    )
  })

  it('ticks later than every stored stamp it takes in, whatever the physical clock reads', () => {
    const stamp = fc
      .record({
        wall: fc.integer({ min: 0, max: 2 ** 42 }),
        counter: fc.integer({ min: 0, max: 0xffff }),
        node: fc.constantFrom('b', 'mac1', 'mcp0a1b'),
      })
      .map((hlc) => ({ text: formatHlc(hlc), valid: true }))
    // Fields never set are stored empty; anything else malformed is skipped.
    const junk = fc
      .constantFrom('', null, undefined, 'nope', '9'.repeat(40), 'zzzz-0000-a')
      .map((text) => ({ text, valid: false }))
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 42 }),
        fc.array(fc.oneof(stamp, junk), { maxLength: 12 }),
        (physical, stored) => {
          const clock = createClock('a', () => physical)
          const texts = stored.map((s) => s.text)
          receiveStored(clock, texts)
          const next = clock.tick()
          const valid = stored.filter((s) => s.valid).map((s) => s.text ?? '')
          expect(valid.filter((s) => compareHlc(next, s) !== 1)).toEqual([])
        },
      ),
    )
  })

  it('takes in nothing from stamps that are all empty or malformed', () => {
    const clock = createClock('a', () => 1000)
    receiveStored(clock, ['', null, undefined, 'nope'])
    expect(parseHlc(clock.tick())).toEqual({ wall: 1000, counter: 0, node: 'a' })
  })

  it('a received timestamp is always followed by a later local one', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 42 }),
        fc.integer({ min: 0, max: 2 ** 42 }),
        fc.integer({ min: 0, max: 0xfffe }),
        (local, remoteWall, remoteCounter) => {
          const clock = createClock('a', () => local)
          const remote = formatHlc({ wall: remoteWall, counter: remoteCounter, node: 'b' })
          const merged = clock.receive(remote)
          expect(compareHlc(merged, remote)).toBe(1)
          expect(compareHlc(clock.tick(), merged)).toBe(1)
        },
      ),
    )
  })
})
