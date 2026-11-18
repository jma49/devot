import { describe, expect, it } from 'vitest'
import { inspectorRoom } from './room'

describe('the outline column', () => {
  it('needs the panes’ least width and its own', () => {
    expect(inspectorRoom(460, 'edit', 240)).toBe(220)
    expect(inspectorRoom(459, 'edit', 240)).toBe(219)
    expect(inspectorRoom(699, 'split', 240)).toBe(219)
    expect(inspectorRoom(700, 'split', 240)).toBe(220)
  })
})
