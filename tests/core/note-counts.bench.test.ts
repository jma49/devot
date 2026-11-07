// The footer and Note Info count the open note after each pause in typing, so counting stays linear in its length.
import { describe, expect, it } from 'vitest'
import { noteCounts } from '../../src/core/noteCounts'
import { expectLinearGrowth, fourfoldGrowth, GROWTH_TIMEOUT } from '../support/growth'

const RICH = [
  '## Section with a [link](https://example.com/page "title") and `code`',
  '',
  'Some *emphasis*, **strong** and ~~struck~~ text, a [[Wiki note|label]] and <span>html</span>.',
  '- [x] a done task with \\*escapes\\*',
  '- [ ] caf\u00e9, na\u0308ive, \u540c\u6b65 and \u{1f600}',
  '',
  '| a | b |',
  '| --- | --- |',
  '| one | two |',
  '',
  '```js',
  'const x = 1',
  '```',
  '',
].join('\n')

describe('counting a note', () => {
  it(
    'takes time linear in the length of the note',
    (context) => {
      const growth = fourfoldGrowth((blocks) => {
        const note = RICH.repeat(blocks)
        return () => {
          expect(noteCounts(note).words).toBeGreaterThan(blocks)
        }
      }, 400)
      expectLinearGrowth(context, growth)
    },
    GROWTH_TIMEOUT,
  )
})
