import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { fromBase64, toBase64 } from './base64'

function withoutNativeBase64(run: () => void): void {
  const proto = Uint8Array.prototype as { toBase64?: unknown }
  const ctor = Uint8Array as { fromBase64?: unknown }
  const saved = { toBase64: proto.toBase64, fromBase64: ctor.fromBase64 }
  delete proto.toBase64
  delete ctor.fromBase64
  try {
    run()
  } finally {
    if (saved.toBase64) proto.toBase64 = saved.toBase64
    if (saved.fromBase64) ctor.fromBase64 = saved.fromBase64
  }
}

describe('base64', () => {
  it('round-trips arbitrary byte arrays with and without native engine support', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 4096 }), (bytes) => {
        const encoded = toBase64(bytes)
        expect(encoded).toBe(Buffer.from(bytes).toString('base64'))
        expect(fromBase64(encoded)).toEqual(bytes)
        withoutNativeBase64(() => {
          expect(toBase64(bytes)).toBe(encoded)
          expect(fromBase64(encoded)).toEqual(bytes)
        })
      }),
    )
  })

  it('handles buffers well past the JS argument stack limit in both paths', () => {
    const large = new Uint8Array(200_000)
    for (let i = 0; i < large.length; i += 1) large[i] = (i * 31 + 7) & 0xff
    const expected = Buffer.from(large).toString('base64')
    expect(toBase64(large)).toBe(expected)
    expect(fromBase64(expected)).toEqual(large)
    withoutNativeBase64(() => {
      expect(toBase64(large)).toBe(expected)
      expect(fromBase64(expected)).toEqual(large)
    })
  })

  it('ignores ASCII whitespace and throws on malformed base64', () => {
    expect(fromBase64(' A Q I D \n ')).toEqual(Uint8Array.of(1, 2, 3))
    expect(() => fromBase64('not valid base64!')).toThrow(/base64|character/i)
    withoutNativeBase64(() => {
      expect(fromBase64(' A Q I D \n ')).toEqual(Uint8Array.of(1, 2, 3))
      expect(() => fromBase64('not valid base64!')).toThrow(/base64|character/i)
    })
  })
})
