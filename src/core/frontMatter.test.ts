import { describe, expect, it } from 'vitest'
import { importTitle, readFrontMatter } from './import'

// A corpus of the front matter people write, read as YAML reads it (comments,
// escapes, block scalars, multi-line lists), then with Devot's own leniency.
// Text that is not valid YAML for a key still gives what the line says.

const fm = (yaml: string) => readFrontMatter(`---\n${yaml}\n---\n`)
const title = (yaml: string) => fm(yaml).title
const tags = (yaml: string) => fm(yaml).tags

describe('front matter titles', () => {
  it('end where a YAML comment starts', () => {
    expect(title('title: Plan # draft')).toBe('Plan')
    expect(title("title: 'Plan # draft' # note")).toBe('Plan # draft')
    expect(title('title: "Plan # draft"  # note')).toBe('Plan # draft')
    // A # inside a word is text, as is one in a quoted title.
    expect(title('title: C#')).toBe('C#')
    expect(title('title: Issue#12 fixed')).toBe('Issue#12 fixed')
    expect(title('title: "#1 plan"')).toBe('#1 plan')
  })

  it('read the escapes of a double-quoted title', () => {
    expect(title(String.raw`title: "A\x41é\U0001F600\t\"q\" \\ \/"`)).toBe('AAé\u{1F600}\t"q" \\ /')
    expect(title(String.raw`title: "line\nbreak"`)).toBe('line\nbreak')
    // Single quotes read no escapes, and double a quote to write one.
    expect(title(String.raw`title: 'a\x41 it''s'`)).toBe(String.raw`a\x41 it's`)
  })

  it('read block scalars and multi-line scalars as one title', () => {
    expect(title('title: >\n  A folded\n  title')).toBe('A folded title')
    // A literal block keeps its line break; a note's title is on one line.
    expect(title('title: |\n  A literal\n  title\nother: x')).toBe('A literal\ntitle')
    expect(importTitle('---\ntitle: |\n  A literal\n  title\n---\n', 'n.md')).toBe(
      'A literal title',
    )
    expect(title('title: >-\n  Stripped\n')).toBe('Stripped')
    expect(title('title: A long\n  wrapped title\nstatus: active')).toBe('A long wrapped title')
    expect(title('title: "A quoted\n  wrapped title"')).toBe('A quoted wrapped title')
  })

  it('are none when YAML says null or nothing', () => {
    expect(title('title: ~')).toBeNull()
    expect(title('title: null')).toBeNull()
    expect(title('title: Null')).toBeNull()
    expect(title('title: >')).toBeNull()
    expect(title('title: |')).toBeNull()
    expect(title('title:')).toBeNull()
    expect(title('title: # none yet')).toBeNull()
    // Quoted, they are text.
    expect(title('title: "~"')).toBe('~')
    expect(title("title: 'null'")).toBe('null')
  })

  it('keep numbers, booleans and dates as written', () => {
    expect(title('title: 2024')).toBe('2024')
    expect(title('title: 1.0')).toBe('1.0')
    expect(title('title: true')).toBe('true')
    expect(title('title: 2026-03-03')).toBe('2026-03-03')
    expect(title('title: 0x1F')).toBe('0x1F')
  })

  it('are none when the value is a list or a map', () => {
    expect(title('title:\n  - a\n  - b')).toBeNull()
    expect(title('title:\n  a: b')).toBeNull()
  })

  it('take the last of a repeated key and match the key in any case', () => {
    expect(title('title: First\nTitle: Second')).toBe('Second')
  })

  it('still read what a line says when it is not valid YAML', () => {
    expect(title('title: Plan: draft')).toBe('Plan: draft')
    expect(title('title: Plan: draft # note')).toBe('Plan: draft')
    expect(title('title: "unclosed')).toBe('"unclosed')
    // Another key's mistake does not touch this one.
    expect(title('other: a: b\ntitle: Fine\nbad: [')).toBe('Fine')
    expect(title('title: Fine\n\tbroken: [')).toBe('Fine')
  })

  it('come from the first heading when YAML gives none', () => {
    expect(importTitle('---\ntitle: ~\n---\n# Heading\n', 'note.md')).toBe('Heading')
    expect(importTitle('---\ntitle: >\n---\n', 'file-name.md')).toBe('file-name')
    expect(importTitle('---\ntitle: Plan # draft\n---\n# Heading\n', 'note.md')).toBe('Plan')
  })
})

describe('front matter tags', () => {
  it('end a flow list at its bracket, whatever follows', () => {
    expect(tags('tags: [a, b] # two')).toEqual(['a', 'b'])
    expect(tags('tags: [a, b]   ')).toEqual(['a', 'b'])
    expect(tags('tags: ["a, b", \'c # d\', e]')).toEqual(['a, b', 'c # d', 'e'])
  })

  it('read a flow list over several lines, with a trailing comma and comments', () => {
    expect(
      tags('tags: [\n  alpha,\n  "beta gamma", # second\n  delta,\n]\nstatus: active'),
    ).toEqual(['alpha', 'beta gamma', 'delta'])
    expect(fm('tags: [\n  alpha,\n  beta\n]\nstatus: active').status).toBe('active')
  })

  it('read a block list with comments, quotes and escapes', () => {
    expect(
      tags("tags:\n  - one # first\n  - \"two\\tthree\"\n  - 'it''s'\n  # skipped\n  - four"),
    ).toEqual(['one', 'two\tthree', "it's", 'four'])
    expect(tags('tags: # list below\n  - a\n  - b')).toEqual(['a', 'b'])
    expect(tags('tags:\n- x\n- y\nstatus: active')).toEqual(['x', 'y'])
  })

  it('read a comma-separated value up to a comment', () => {
    expect(tags('tags: one, two # three')).toEqual(['one', 'two'])
    expect(tags('tags: one, two ,#three')).toEqual(['one', 'two', 'three'])
    expect(tags('tags: solo')).toEqual(['solo'])
    expect(tags('tags: "a, b", c')).toEqual(['a, b', 'c'])
  })

  it('drop a leading # and empty or repeated tags, in any style', () => {
    expect(tags('tags: ["#work", \'##home\', Work, "", ~]')).toEqual(['work', 'home'])
    expect(tags('tags:\n  - "#work"\n  - WORK')).toEqual(['work'])
  })

  it('keep numbers and booleans as written', () => {
    expect(tags('tags: [2024, 1.0, true, yes]')).toEqual(['2024', '1.0', 'true', 'yes'])
    expect(tags('tags:\n  - 2024\n  - null2')).toEqual(['2024', 'null2'])
  })

  it('are none for null, an empty list or a map', () => {
    expect(tags('tags: ~')).toEqual([])
    expect(tags('tags: []')).toEqual([])
    expect(tags('tags:')).toEqual([])
    expect(tags('tags:\n  a: b')).toEqual([])
  })

  it('still read what a line says when it is not valid YAML', () => {
    expect(tags('tags: [#a, #b]')).toEqual(['a', 'b'])
    expect(tags('tags: [a, b')).toEqual(['a', 'b'])
  })
})

describe('other front matter keys', () => {
  it('read a status and a notebook up to a comment', () => {
    expect(fm('status: Active # now').status).toBe('active')
    expect(fm('status: "on hold"').status).toBe('on_hold')
    expect(fm('status: ~').status).toBeNull()
    expect(fm('status: 1').status).toBeNull()
    expect(fm('notebook: Work/Meetings # where').notebook).toBe('Work/Meetings')
    expect(fm("notebook: ' Work '").notebook).toBe('Work')
    expect(fm('notebook: >\n  Work\n  Plans').notebook).toBe('Work Plans')
  })

  it('read CRLF line breaks like line feeds', () => {
    const meta = readFrontMatter(
      '---\r\ntitle: Plan # draft\r\ntags: [\r\n  a,\r\n  b\r\n]\r\nstatus: active\r\n---\r\n',
    )
    expect(meta).toEqual({ title: 'Plan', notebook: null, tags: ['a', 'b'], status: 'active' })
  })

  it('read nothing from a note that has no front matter, or keys under another key', () => {
    expect(readFrontMatter('title: x\n')).toEqual({
      title: null,
      notebook: null,
      tags: [],
      status: null,
    })
    expect(fm('meta:\n  title: nested\n  tags: [x]')).toEqual({
      title: null,
      notebook: null,
      tags: [],
      status: null,
    })
  })
})
