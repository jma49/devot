import { describe, expect, it } from 'vitest'
import { readFence } from './fences'

describe('readFence', () => {
  it('closes a fence on a line that ends with the CR of a CRLF', () => {
    const open = readFence('```\r', undefined).fence
    expect(open).toEqual({ mark: '`', size: 3, depth: 0 })
    expect(readFence('```\r', open)).toEqual({ fence: undefined, code: true })
    expect(readFence('```js\r', open)).toEqual({ fence: open, code: true })
  })
})
