import { describe, expect, it } from 'vitest'
import { propertyType, readProperties, withProperty } from './properties'

const note = (yaml: string, body = 'Body\n') => `---\n${yaml}---\n${body}`

describe('readProperties', () => {
  it('reads scalars, lists and dates, leaving out the note fields', () => {
    expect(
      readProperties(
        note(
          'title: T\ntags: [a]\nstatus: active\nnotebook: N\nrating: 4\ndone: true\ndue: 2026-11-20\nauthors:\n  - Ann\n  - Bo\nurl: https://x.test\nempty:\n',
        ),
      ),
    ).toEqual({
      rating: 4,
      done: true,
      due: '2026-11-20',
      authors: ['Ann', 'Bo'],
      url: 'https://x.test',
      empty: null,
    })
  })

  it('keeps quoted numbers as text and the last of a repeated key', () => {
    expect(readProperties(note('code: "007"\nn: 1\nn: 2\n'))).toEqual({ code: '007', n: 2 })
  })

  it('leaves out maps and lists of maps, and reads nothing from invalid YAML or no front matter', () => {
    expect(readProperties(note('a:\n  b: 1\nc:\n  - d: 1\ne: x\n'))).toEqual({ e: 'x' })
    expect(readProperties(note('a: [1, \n'))).toEqual({})
    expect(readProperties('No front matter\n')).toEqual({})
    expect(readProperties('---\n---\nBody')).toEqual({})
  })

  it('reads keys in any script', () => {
    expect(readProperties(note('\u4f5c\u8005: Lu\n'))).toEqual({ '\u4f5c\u8005': 'Lu' })
  })
})

describe('propertyType', () => {
  it('is the one type every value has, text when they differ, a list when any is', () => {
    expect(propertyType([1, 2.5, null])).toBe('number')
    expect(propertyType([true, false])).toBe('checkbox')
    expect(propertyType(['2026-01-02', '2025-12-31'])).toBe('date')
    expect(propertyType(['2026-13-02'])).toBe('text')
    expect(propertyType([1, 'a'])).toBe('text')
    expect(propertyType(['a', ['b']])).toBe('list')
    expect(propertyType([null])).toBe('text')
    expect(propertyType([])).toBe('text')
  })
})

describe('withProperty', () => {
  it('replaces the key in place and leaves every other line as written', () => {
    const before = note('title: T  # kept\nrating: 3 # old\ndue: 2026-01-01\n')
    expect(withProperty(before, 'rating', 5)).toBe(
      note('title: T  # kept\nrating: 5\ndue: 2026-01-01\n'),
    )
  })

  it('replaces block values whole', () => {
    expect(withProperty(note('a:\n  - x\n  - y\nb: 1\n'), 'a', ['z'])).toBe(
      note('a:\n  - z\nb: 1\n'),
    )
    expect(withProperty(note('a: |\n  one\n  two\nb: 1\n'), 'a', 'three')).toBe(
      note('a: three\nb: 1\n'),
    )
    expect(withProperty(note('a:\nb: 1\n'), 'a', true)).toBe(note('a: true\nb: 1\n'))
  })

  it('adds a missing key after the last one, before blank lines', () => {
    expect(withProperty(note('a: 1\n\n'), 'b', 'x')).toBe(note('a: 1\nb: x\n\n'))
    expect(withProperty('---\n---\nBody', 'b', 2)).toBe('---\nb: 2\n---\nBody')
  })

  it('makes front matter for a note without any', () => {
    expect(withProperty('# Heading\n', 'due', '2026-11-20')).toBe(
      '---\ndue: 2026-11-20\n---\n# Heading\n',
    )
  })

  it('quotes text that YAML would read as another type, so it reads back as written', () => {
    for (const value of ['007', 'true', 'null', '- a', 'a: b', '#x', '', ' padded ', '[1]']) {
      const written = withProperty(note('k: 1\n'), 'k', value)
      expect(readProperties(written)['k']).toBe(value)
    }
    expect(readProperties(withProperty('', 'k', null))['k']).toBeNull()
    expect(readProperties(withProperty('', 'k', []))['k']).toEqual([])
    expect(readProperties(withProperty('', 'k', ['a, b', '1']))['k']).toEqual(['a, b', '1'])
  })

  it('writes a key that needs quoting', () => {
    const written = withProperty('', 'a: b', 'x')
    expect(readProperties(written)).toEqual({ 'a: b': 'x' })
    expect(withProperty(written, 'a: b', 'y')).toBe(withProperty('', 'a: b', 'y'))
  })

  it('edits the last of a repeated key', () => {
    expect(withProperty(note('n: 1\nn: 2\n'), 'n', 3)).toBe(note('n: 1\nn: 3\n'))
  })

  it('refuses note fields, bad keys, bad values and front matter that is not a valid map', () => {
    expect(() => withProperty('', 'Title', 'x')).toThrow('E_PROPERTY_KEY_INVALID')
    expect(() => withProperty('', ' k', 'x')).toThrow('E_PROPERTY_KEY_INVALID')
    expect(() => withProperty('', 'a\nb', 'x')).toThrow('E_PROPERTY_KEY_INVALID')
    expect(() => withProperty('', 'k'.repeat(65), 'x')).toThrow('E_PROPERTY_KEY_INVALID')
    expect(() => withProperty('', 'k', 'a\nb')).toThrow('E_PROPERTY_VALUE_INVALID')
    expect(() => withProperty('', 'k', Number.NaN)).toThrow('E_PROPERTY_VALUE_INVALID')
    expect(() => withProperty('', 'k', 'x'.repeat(2001))).toThrow('E_PROPERTY_VALUE_TOO_LONG')
    expect(() => withProperty(note('a: [1,\n'), 'k', 'x')).toThrow('E_FRONT_MATTER_INVALID')
    expect(() => withProperty(note('- a\n'), 'k', 'x')).toThrow('E_FRONT_MATTER_INVALID')
  })

  it('reads back what it writes, whatever the front matter held', () => {
    const starts = ['Body\n', note(''), note('a: 1\n# c\n\nb: [x]\n'), note('k: |\n  t\n')]
    const values = [0, -1.5, true, 'text', '2026-11-20', ['a', 'b'], null]
    for (const start of starts) {
      for (const value of values) {
        const written = withProperty(start, 'k', value)
        expect(readProperties(written)['k']).toEqual(value)
        expect(written.endsWith('---\nBody\n')).toBe(true)
      }
    }
  })
})
