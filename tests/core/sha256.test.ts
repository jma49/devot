import { createHash } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from '../../src/core/sha256'

const node = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')

describe('sha256Hex', () => {
  it('gives the standard test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
  })

  it('hashes text as UTF-8, across block boundaries, like Node', () => {
    // Lengths around the 55/56/64-byte padding edges, and several blocks.
    for (const length of [55, 56, 57, 63, 64, 65, 119, 120, 1000]) {
      const text = 'x'.repeat(length)
      expect(sha256Hex(text)).toBe(node(text))
    }
    const cjk = String.fromCodePoint(0x4e2d, 0x6587, 0x1f600)
    expect(sha256Hex(cjk)).toBe(node(cjk))
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 300 }), (text) => {
        expect(sha256Hex(text)).toBe(node(text))
      }),
    )
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        expect(sha256Hex(bytes)).toBe(node(bytes))
      }),
    )
  })
})
