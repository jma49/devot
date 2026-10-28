import { describe, expect, it } from 'vitest'
import { splitBlocks } from '../../src/core/preview/blocks'
import { expectLinearGrowth, fourfoldGrowth } from '../support/growth'

describe('splitting a note into blocks', () => {
  it('takes time linear in a line of unclosed tags', (context) => {
    const growth = fourfoldGrowth(
      (n) => {
        const note = '<a '.repeat(n)
        return () => splitBlocks(note, 2000)
      },
      20_000,
      5,
    )
    expectLinearGrowth(context, growth)
  })

  it('still tells a tag that closes itself from one that stays open', () => {
    expect(splitBlocks('<foo a="1" />\n\nx', 1)).toHaveLength(2)
    expect(splitBlocks('<foo a="1">\n\nx', 1)).toHaveLength(1)
    expect(splitBlocks('<foo a="1"\n\nx\n\n<bar />', 1)).toHaveLength(1)
  })
})
