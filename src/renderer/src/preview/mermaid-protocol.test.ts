import { describe, expect, it } from 'vitest'
import { isFrameMessage } from './mermaid-protocol'

describe('isFrameMessage', () => {
  it('accepts a drawing and a failure with its reason', () => {
    expect(isFrameMessage({ type: 'rendered', id: 1, svg: '<svg/>' })).toBe(true)
    expect(isFrameMessage({ type: 'failed', id: 2, reason: 'parse' })).toBe(true)
    expect(isFrameMessage({ type: 'failed', id: 3, reason: 'render' })).toBe(true)
  })

  it('refuses a failure without a reason the frame can give', () => {
    expect(isFrameMessage({ type: 'failed', id: 4 })).toBe(false)
    expect(isFrameMessage({ type: 'failed', id: 5, reason: 'timeout' })).toBe(false)
    expect(isFrameMessage({ type: 'failed', id: 6, reason: 'other' })).toBe(false)
    expect(isFrameMessage({ type: 'rendered', id: 7 })).toBe(false)
    expect(isFrameMessage({ type: 'rendered', id: 1.5, svg: '' })).toBe(false)
  })
})
