import { describe, expect, it } from 'vitest'
import {
  httpsUrl,
  parseGithubBlobUrl,
  parseLineRange,
  tokenizeFenceInfo,
  withoutHash,
} from '../../src/core'

describe('tokenizeFenceInfo', () => {
  it('splits the head from bare, double and single quoted pairs', () => {
    const { head, meta } = tokenizeFenceInfo(`ts a=1 b="two words" C='x y' d=`)
    expect(head).toBe('ts')
    expect([...meta]).toEqual([
      ['a', '1'],
      ['b', 'two words'],
      ['c', 'x y'],
      ['d', ''],
    ])
  })

  it('keeps the first of a repeated key, skips stray words, keeps = in values', () => {
    const { meta } = tokenizeFenceInfo(
      'js {1,3} line=1 line=2 note junk url=https://x.dev/?a=b&c=d',
    )
    expect(meta.get('line')).toBe('1')
    expect(meta.get('url')).toBe('https://x.dev/?a=b&c=d')
    expect(meta.has('junk')).toBe(false)
  })

  it('does not read a pair out of a quoted value', () => {
    const { meta } = tokenizeFenceInfo('js title="a line=9 b" line=2')
    expect(meta.get('title')).toBe('a line=9 b')
    expect(meta.get('line')).toBe('2')
  })

  it('handles an empty or head-only info string', () => {
    expect(tokenizeFenceInfo('').head).toBe('')
    expect(tokenizeFenceInfo('  js:app.js  ')).toEqual({ head: 'js:app.js', meta: new Map() })
  })
})

describe('parseLineRange', () => {
  it.each([
    ['5', { start: 5, end: null }],
    ['5-9', { start: 5, end: 9 }],
    ['5-5', { start: 5, end: null }],
    ['9-5', null],
    ['0', null],
    ['-3', null],
    ['1e3', null],
    ['99999999999', null],
    ['', null],
  ])('reads %j', (value, expected) => {
    expect(parseLineRange(value)).toEqual(expected)
  })
})

describe('httpsUrl and withoutHash', () => {
  it('accepts https only, within a size limit', () => {
    expect(httpsUrl('https://example.com/a')).toBe('https://example.com/a')
    expect(httpsUrl('http://example.com')).toBeNull()
    expect(httpsUrl('https://a b')).toBeNull()
    expect(httpsUrl(`https://a.dev/${'x'.repeat(2048)}`)).toBeNull()
  })

  it('drops the fragment', () => {
    expect(withoutHash('https://a.dev/x#L1')).toBe('https://a.dev/x')
    expect(withoutHash('https://a.dev/x')).toBe('https://a.dev/x')
  })
})

describe('parseGithubBlobUrl', () => {
  it('parses a branch link with a line range', () => {
    expect(parseGithubBlobUrl('https://github.com/o/r/blob/main/src/a.ts#L10-L20')).toEqual({
      owner: 'o',
      repo: 'r',
      ref: 'main',
      path: 'src/a.ts',
      lines: { start: 10, end: 20 },
      isCommit: false,
    })
  })

  it('knows a 40-character commit and a single line, also with columns', () => {
    const sha = 'a'.repeat(40)
    const blob = parseGithubBlobUrl(`https://github.com/o/r/blob/${sha}/a.ts#L7C2`)
    expect(blob).toMatchObject({ ref: sha, isCommit: true, lines: { start: 7, end: null } })
  })

  it('has no lines without a usable fragment', () => {
    expect(parseGithubBlobUrl('https://github.com/o/r/blob/main/a.ts')?.lines).toBeNull()
    expect(parseGithubBlobUrl('https://github.com/o/r/blob/main/a.ts#readme')?.lines).toBeNull()
    expect(parseGithubBlobUrl('https://github.com/o/r/blob/main/a.ts#L9-L2')?.lines).toBeNull()
  })

  it.each([
    'http://github.com/o/r/blob/main/a.ts',
    'https://github.com/o/r/tree/main/src',
    'https://github.com/o/r/issues/1',
    'https://gist.github.com/o/r/blob/main/a.ts',
    'https://github.com.evil.dev/o/r/blob/main/a.ts',
    'https://github.com/o/r/blob/main',
    'not a url',
  ])('rejects %s', (url) => {
    expect(parseGithubBlobUrl(url)).toBeNull()
  })
})

describe('tokenizeFenceInfo without a language', () => {
  it('reads a first pair as meta', () => {
    const { head, meta } = tokenizeFenceInfo('line=3 url=https://a.dev/x')
    expect(head).toBe('')
    expect(meta.get('line')).toBe('3')
    expect(meta.get('url')).toBe('https://a.dev/x')
  })
})
