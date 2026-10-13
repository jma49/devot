import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  MAX_FIND_MATCHES,
  expandReplacement,
  findMatches,
  replaceAll,
  replacementChanges,
  type FindOptions,
} from './find'
import { escapeRegExp } from './search'

const plain = (query: string, caseSensitive = false): FindOptions => ({
  query,
  regexp: false,
  caseSensitive,
})
const regexp = (query: string, caseSensitive = false): FindOptions => ({
  query,
  regexp: true,
  caseSensitive,
})
const spans = (text: string, options: FindOptions) =>
  findMatches(text, options).matches.map((m) => [m.from, m.to])

// Built from code points so the file itself holds no CJK characters.
const CHINESE = String.fromCodePoint(0x4e2d, 0x6587)
const EMOJI = String.fromCodePoint(0x1f600)

describe('findMatches', () => {
  it('finds text in any case unless case matters', () => {
    expect(spans('Cat cat CAT', plain('cat'))).toEqual([
      [0, 3],
      [4, 7],
      [8, 11],
    ])
    expect(spans('Cat cat CAT', plain('cat', true))).toEqual([[4, 7]])
    expect(spans('Cat cat CAT', regexp('c.t'))).toHaveLength(3)
    expect(spans('Cat cat CAT', regexp('c.t', true))).toEqual([[4, 7]])
  })

  it('folds case beyond ASCII', () => {
    expect(spans('Äpfel und äpfel', plain('äpfel'))).toEqual([
      [0, 5],
      [10, 15],
    ])
  })

  it('takes plain text literally', () => {
    expect(spans('a.b axb', plain('a.b'))).toEqual([[0, 3]])
    expect(spans('f(x) [y] {z} a+b ^$ \\d', plain('(x)'))).toEqual([[1, 4]])
    for (const query of ['[y]', '{z}', 'a+b', '^$', '\\d', '-', '/'])
      expect(findMatches('f(x) [y] {z} a+b ^$ \\d - /', plain(query)).matches).toHaveLength(1)
  })

  it('matches a regular expression line by line', () => {
    expect(spans('a1 b22', regexp('\\d+'))).toEqual([
      [1, 2],
      [4, 6],
    ])
    expect(spans('- a\n- b\nc -', regexp('^- '))).toEqual([
      [0, 2],
      [4, 6],
    ])
    expect(spans('ab\ncd', regexp('b$'))).toEqual([[1, 2]])
    expect(spans('ab\ncd', regexp('b\\ncd'))).toEqual([[1, 5]])
  })

  it('reports an invalid pattern instead of throwing', () => {
    for (const query of ['(', '[a', 'a)', '*', '+a', '\\', '(?<n>a)(?<n>b)']) {
      const result = findMatches('text (', regexp(query))
      expect(result).toEqual({ matches: [], invalid: true, capped: false })
    }
    // The same characters are plain text when regular expressions are off.
    expect(findMatches('text (', plain('(')).invalid).toBe(false)
  })

  it('accepts escapes and brackets that only the older syntax allows', () => {
    const text = '# Title\n- item {a} [b]'
    expect(spans(text, regexp('^\\#'))).toEqual([[0, 1]])
    expect(spans(text, regexp('^\\- '))).toEqual([[8, 10]])
    expect(spans(text, regexp('\\{a}'))).toEqual([[15, 18]])
    expect(spans(text, regexp('b]'))).toEqual([[20, 22]])
    expect(spans(text, regexp('a{'))).toEqual([])
    expect(findMatches(text, regexp('a{')).invalid).toBe(false)
  })

  it('finds nothing for an empty query', () => {
    expect(findMatches('text', plain(''))).toEqual({ matches: [], invalid: false, capped: false })
    expect(findMatches('text', regexp(''))).toEqual({ matches: [], invalid: false, capped: false })
  })

  it('keeps zero-length matches and moves past them', () => {
    expect(spans('a\nb\n', regexp('^'))).toEqual([
      [0, 0],
      [2, 2],
      [4, 4],
    ])
    expect(spans('baaac', regexp('a*'))).toEqual([
      [0, 0],
      [1, 4],
      [4, 4],
      [5, 5],
    ])
    expect(spans('', regexp('^'))).toEqual([[0, 0]])
  })

  it('never splits a character outside the basic plane', () => {
    const text = `a${EMOJI}b`
    expect(spans(text, regexp('(?:)'))).toEqual([
      [0, 0],
      [1, 1],
      [3, 3],
      [4, 4],
    ])
    expect(spans(text, regexp('.'))).toEqual([
      [0, 1],
      [1, 3],
      [3, 4],
    ])
    expect(spans(text, plain(EMOJI))).toEqual([[1, 3]])
  })

  it('finds CJK text in UTF-16 offsets', () => {
    expect(spans(`x${CHINESE}y${CHINESE}`, plain(CHINESE))).toEqual([
      [1, 3],
      [4, 6],
    ])
    expect(spans(`${EMOJI}${CHINESE}`, regexp('\\p{Script=Han}+'))).toEqual([[2, 4]])
  })

  it('stops at the limit and says so', () => {
    const result = findMatches('aaaa', plain('a'), 3)
    expect(result.matches).toHaveLength(3)
    expect(result.capped).toBe(true)
    expect(findMatches('aaa', plain('a'), 3).capped).toBe(false)
    expect(MAX_FIND_MATCHES).toBeGreaterThanOrEqual(1000)
  })

  it('keeps the groups a replacement needs', () => {
    const [match] = findMatches('me@host', regexp('(?<user>\\w+)@(\\w+)')).matches
    expect(match?.captures).toEqual(['me@host', 'me', 'host'])
    expect(match?.groups).toEqual({ user: 'me' })
  })
})

describe('escapeRegExp', () => {
  it('makes a find pattern that matches the text itself', () => {
    const text = 'f(x) [y] {z} a+b? ^$ \\d | . * - /'
    expect(findMatches(text, regexp(escapeRegExp(text), true)).matches).toHaveLength(1)
    expect(spans(`ab${text}`, regexp(escapeRegExp(text)))).toEqual([[2, 2 + text.length]])
  })
})

describe('expandReplacement', () => {
  const one = (text: string, options: FindOptions, template: string) => {
    const [match] = findMatches(text, options).matches
    if (!match) throw new Error('E_TEST_NO_MATCH')
    return expandReplacement(template, match, text, options.regexp)
  }

  it('inserts plain replacements as typed', () => {
    expect(one('a-b', plain('-'), '$&$1$$')).toBe('$&$1$$')
  })

  it('expands groups in regular expression replacements', () => {
    expect(one('me@host', regexp('(\\w+)@(\\w+)'), '$2 at $1')).toBe('host at me')
    expect(one('me@host', regexp('(?<user>\\w+)@(\\w+)'), '<$<user>>')).toBe('<me>')
    expect(one('me@host', regexp('@'), "[$`|$&|$']")).toBe('[me|@|host]')
    expect(one('me@host', regexp('@'), '$$ $9 $<x>')).toBe('$ $9 $<x>')
    expect(one('abcdefghijk', regexp('(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)'), '$11-$10-$1')).toBe(
      'k-j-a',
    )
  })
})

describe('replaceAll', () => {
  it('replaces every match and counts them', () => {
    expect(replaceAll('one two one', plain('one'), '1')).toEqual({ text: '1 two 1', count: 2 })
    expect(replaceAll('One one', plain('one', true), '1')).toEqual({ text: 'One 1', count: 1 })
    expect(replaceAll('a\nb', regexp('^'), '> ')).toEqual({ text: '> a\n> b', count: 2 })
    expect(replaceAll(`${CHINESE}!`, plain(CHINESE), 'zh')).toEqual({ text: 'zh!', count: 1 })
  })

  it('lists the changes in order, empty matches included', () => {
    expect(replacementChanges('baaac', regexp('a*'), '-')).toEqual([
      { from: 0, to: 0, insert: '-' },
      { from: 1, to: 4, insert: '-' },
      { from: 4, to: 4, insert: '-' },
      { from: 5, to: 5, insert: '-' },
    ])
    expect(replacementChanges('x', regexp('('), '-')).toEqual([])
  })

  it('leaves the text alone for an invalid pattern or no match', () => {
    expect(replaceAll('text (', regexp('('), 'x')).toEqual({ text: 'text (', count: 0 })
    expect(replaceAll('text', plain('none'), 'x')).toEqual({ text: 'text', count: 0 })
  })

  it('is not limited by the match cap', () => {
    const text = 'a'.repeat(MAX_FIND_MATCHES + 5)
    expect(replaceAll(text, plain('a'), 'b')).toEqual({
      text: 'b'.repeat(MAX_FIND_MATCHES + 5),
      count: MAX_FIND_MATCHES + 5,
    })
  })

  it('agrees with String.prototype.replace for regular expressions', () => {
    const text = fc.string({ unit: fc.constantFrom('a', 'b', 'A', '\n', ' ', '1', EMOJI) })
    const pattern = fc.constantFrom(
      'a',
      'a*',
      'a+?',
      '^',
      '$',
      '^a',
      'b$',
      '\\d',
      '(a)(b)?',
      '(?<x>a|b)',
      '.',
      '\\s+',
      '(?:)',
      '[^a]',
      '\\bA',
    )
    const template = fc.constantFrom('', 'x', '$&$&', '[$1]', '$2', '$<x>', '$$', "$`|$'", '$0')
    fc.assert(
      fc.property(text, pattern, template, fc.boolean(), (t, p, r, caseSensitive) => {
        const native = t.replace(new RegExp(p, `gmu${caseSensitive ? '' : 'i'}`), r)
        expect(replaceAll(t, regexp(p, caseSensitive), r).text).toBe(native)
      }),
    )
  })

  it('agrees with a plain split and join for text', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom('a', 'b', '.', '*', '$', '(') }),
        fc.string({ unit: fc.constantFrom('a', 'b', '.', '*', '$', '('), minLength: 1 }),
        fc.string({ unit: fc.constantFrom('x', '$', '&', '1') }),
        (t, q, r) => {
          expect(replaceAll(t, plain(q, true), r).text).toBe(t.split(q).join(r))
        },
      ),
    )
  })
})
