import { describe, expect, it } from 'vitest'
import { previewShape } from '../support/preview-html'

describe('single line breaks in a paragraph', () => {
  it('show as line breaks', async () => {
    expect(await previewShape('one\ntwo\nthree')).toBe('<p>one<br></br>two<br></br>three</p>')
  })

  it('keep a bold first line apart from the next line', async () => {
    expect(await previewShape('**Phase 1**\nBegins here')).toBe(
      '<p><strong>Phase 1</strong><br></br>Begins here</p>',
    )
  })

  it('leave blank-line paragraphs, hard breaks and code alone', async () => {
    expect(await previewShape('a\n\nb')).toBe('<p>a</p><p>b</p>')
    expect(await previewShape('a  \nb')).toBe('<p>a<br></br>b</p>')
    expect(await previewShape('```\nx\ny\n```')).toBe('<pre><code>xy</code></pre>')
  })

  it('apply inside lists and quotes', async () => {
    expect(await previewShape('> a\n> b')).toBe('<blockquote><p>a<br></br>b</p></blockquote>')
    expect(await previewShape('- a\n  b')).toBe('<ul><li>a<br></br>b</li></ul>')
  })
})
