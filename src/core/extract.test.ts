import { describe, expect, it } from 'vitest'
import { extractTitle, headline, HEADLINE_CHARS, taskProgress } from './extract'
import { MAX_TITLE_CHARS } from './noteLimits'

describe('extractTitle', () => {
  it('is the first line with text', () => {
    expect(extractTitle('Groceries\nmilk\neggs')).toBe('Groceries')
    expect(extractTitle('\n\n  Plans for May  \nmore')).toBe('Plans for May')
  })

  it('drops heading markers', () => {
    expect(extractTitle('# Weekly review\n\nText')).toBe('Weekly review')
    expect(extractTitle('###   Spaced   ###  \nText')).toBe('Spaced')
    expect(extractTitle('###### Six')).toBe('Six')
    // Not a heading: seven marks, or no space after them.
    expect(extractTitle('####### Seven')).toBe('####### Seven')
    expect(extractTitle('#tag line')).toBe('#tag line')
    // Marks closing a heading go; a `#` in other text stays.
    expect(extractTitle('# Learn C#')).toBe('Learn C#')
    expect(extractTitle('Learn C #')).toBe('Learn C #')
    // `# #` is an empty heading: the next line names the note.
    expect(extractTitle('# #\nNext')).toBe('Next')
  })

  it('drops quote, list and task markers before the text', () => {
    expect(extractTitle('> ## Quoted heading')).toBe('Quoted heading')
    expect(extractTitle('- [ ] Call the bank\n- [x] Pay rent')).toBe('Call the bank')
    expect(extractTitle('1. First step')).toBe('First step')
    expect(extractTitle('* Bullet')).toBe('Bullet')
  })

  it('skips code fences, rules and setext underlines', () => {
    expect(extractTitle('```js\nconst a = 1\n```')).toBe('const a = 1')
    expect(extractTitle('~~~\ncode')).toBe('code')
    expect(extractTitle('---\nIntro')).toBe('Intro')
    expect(extractTitle('* * *\nIntro')).toBe('Intro')
    expect(extractTitle('___\n> ***\nIntro')).toBe('Intro')
    expect(extractTitle('Title\n=====')).toBe('Title')
    expect(extractTitle('=====\nNext')).toBe('Next')
  })

  it('skips lines of markers only', () => {
    expect(extractTitle('#\n> \n- \nReal title')).toBe('Real title')
    expect(extractTitle('   \n\n')).toBe('')
    expect(extractTitle('')).toBe('')
  })

  it('keeps inline Markdown as typed', () => {
    expect(extractTitle('**Bold** idea')).toBe('**Bold** idea')
  })

  it('fits the longest title a note may have', () => {
    const long = 'x'.repeat(MAX_TITLE_CHARS + 50)
    expect(extractTitle(long)).toHaveLength(MAX_TITLE_CHARS)
    // Characters, not UTF-16 units: an emoji is not cut in half.
    const emoji = '\u{1F600}'.repeat(MAX_TITLE_CHARS + 1)
    expect([...extractTitle(emoji)]).toHaveLength(MAX_TITLE_CHARS)
  })
})

describe('headline', () => {
  it('is the first line with readable text, as the list shows an untitled note', () => {
    expect(headline('Groceries\nmilk')).toBe('Groceries')
    expect(headline('# Weekly **review**\n\nText')).toBe('Weekly review')
    expect(headline('- [ ] Call the bank')).toBe('Call the bank')
    expect(headline('[Plan](devot://note/abc) for May')).toBe('Plan for May')
  })

  it('skips front matter, and lines with no text such as an image alone', () => {
    expect(headline('---\ntitle: x\ntags: [a]\n---\n\nBody line')).toBe('Body line')
    expect(headline('![](devot://file/abc)\nCaption')).toBe('Caption')
    // An unclosed fence is not front matter.
    expect(headline('---\nIntro')).toBe('Intro')
  })

  it('is empty for a body with no text', () => {
    expect(headline('')).toBe('')
    expect(headline('  \n#\n> \n![](devot://file/abc)')).toBe('')
  })

  it('is cut short, and reads only the start of a huge body', () => {
    expect([...headline('x'.repeat(500))]).toHaveLength(HEADLINE_CHARS)
    expect(headline('\n'.repeat(100_000) + 'late')).toBe('')
    expect(headline('\u{1F600}'.repeat(500))).toBe('\u{1F600}'.repeat(HEADLINE_CHARS))
  })
})

describe('taskProgress', () => {
  it('counts tasks in lists and quotes, done ones too', () => {
    expect(taskProgress('- [x] one\n* [ ] two\n1. [X] three\n> - [ ] four')).toEqual({
      done: 2,
      total: 4,
    })
  })

  it('counts none in code blocks, front matter or plain brackets', () => {
    const body = '---\ntodo: - [ ] no\n---\n```\n- [ ] code\n```\n[ ] not a list\n- [] empty'
    expect(taskProgress(body)).toEqual({ done: 0, total: 0 })
  })
})
