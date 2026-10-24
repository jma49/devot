import { describe, expect, it } from 'vitest'
import {
  decodeFrame,
  encodeFrame,
  enrollmentVerifier,
  fromBase64Url,
  PROTOCOL_VERSION,
  ProtocolError,
  splitChunks,
  toBase64Url,
} from '../../src/core/sync/protocol'

const codeOf = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return error instanceof ProtocolError ? error.code : 'not a ProtocolError'
  }
  return 'no error'
}

describe('frames', () => {
  it('a message without chunks is a JSON text frame carrying the protocol version', () => {
    const frame = encodeFrame({ type: 'pull', since: 3 })
    expect(typeof frame).toBe('string')
    expect(JSON.parse(frame as string)).toEqual({ v: PROTOCOL_VERSION, type: 'pull', since: 3 })
  })

  it('a message with chunks is one binary frame: header length, JSON header, chunks back to back', () => {
    const a = new Uint8Array([1, 2, 3])
    const b = new Uint8Array([4, 5])
    const frame = encodeFrame({ type: 'push', chunks: [3, 2] }, [a, b])
    expect(frame).toBeInstanceOf(Uint8Array)
    const { message, payload } = decodeFrame(frame)
    expect(message).toEqual({ v: PROTOCOL_VERSION, type: 'push', chunks: [3, 2] })
    expect(splitChunks(payload, [3, 2])).toEqual([a, b])
  })

  it('decodes a binary frame given as an ArrayBuffer or as a view into a larger buffer', () => {
    const frame = encodeFrame({ type: 'x' }, [new Uint8Array([9])]) as Uint8Array
    expect(decodeFrame(frame.slice().buffer).payload).toEqual(new Uint8Array([9]))
    const padded = new Uint8Array(frame.length + 8)
    padded.set(frame, 5)
    expect(decodeFrame(padded.subarray(5, 5 + frame.length)).payload).toEqual(new Uint8Array([9]))
  })

  it('refuses another protocol version with E_SYNC_PROTOCOL', () => {
    expect(codeOf(() => decodeFrame('{"v":2,"type":"pull"}'))).toBe('E_SYNC_PROTOCOL')
    expect(codeOf(() => decodeFrame('{"type":"pull"}'))).toBe('E_SYNC_PROTOCOL')
  })

  it('refuses frames that are not an envelope with E_SYNC_BAD_MESSAGE', () => {
    for (const bad of ['', 'nope', '[1]', 'null', '{"v":1}', '{"v":1,"type":3}']) {
      expect(codeOf(() => decodeFrame(bad))).toBe('E_SYNC_BAD_MESSAGE')
    }
    expect(codeOf(() => decodeFrame(new Uint8Array([0, 0])))).toBe('E_SYNC_BAD_MESSAGE')
    expect(codeOf(() => decodeFrame(new Uint8Array([0, 0, 0, 9, 123])))).toBe('E_SYNC_BAD_MESSAGE')
    expect(codeOf(() => decodeFrame(new Uint8Array([0, 0, 0, 1, 0xff])))).toBe('E_SYNC_BAD_MESSAGE')
  })

  it('refuses chunk lengths that do not add up to the payload', () => {
    const payload = new Uint8Array(5)
    expect(codeOf(() => splitChunks(payload, [2, 2]))).toBe('E_SYNC_BAD_MESSAGE')
    expect(codeOf(() => splitChunks(payload, [3, 3]))).toBe('E_SYNC_BAD_MESSAGE')
    expect(splitChunks(payload, [5])).toHaveLength(1)
  })
})

describe('base64url', () => {
  it('round-trips every byte value without padding', () => {
    const bytes = new Uint8Array(256).map((_, i) => i)
    const text = toBase64Url(bytes)
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(fromBase64Url(text)).toEqual(bytes)
  })

  it('refuses padding, other alphabets and non-canonical text', () => {
    for (const bad of ['AA==', 'A+/A', 'A', 'AB', 3, null]) {
      expect(fromBase64Url(bad)).toBeNull()
    }
    expect(fromBase64Url('AA')).toEqual(new Uint8Array([0]))
  })
})

it('the enrollment verifier is SHA-256 over its label and the secret', async () => {
  const secret = new Uint8Array(32).fill(7)
  const label = new TextEncoder().encode('devot-relay enrollment verifier v1')
  const expected = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new Uint8Array([...label, ...secret])),
  )
  expect(await enrollmentVerifier(secret)).toEqual(expected)
  expect(await enrollmentVerifier(new Uint8Array(32).fill(8))).not.toEqual(expected)
})

it('the enrollment verifier is the one Rust sends when it creates a vault', async () => {
  // src-tauri/src/sync/tests.rs, the_enrollment_secret_matches_known_answers.
  const hex = (text: string) => Uint8Array.from(text.match(/../g)!, (b) => parseInt(b, 16))
  const secret = hex('89a0b71f4097d394c4618e45d1747e030c4f606b586995e6ecfdac1d7a313642')
  expect(await enrollmentVerifier(secret)).toEqual(
    hex('7ed8b8c9ecb100f005b633fa39eef4bc9c065a8b89a9306901935d5695b1a99f'),
  )
})
