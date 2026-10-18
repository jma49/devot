import { describe, expect, it } from 'vitest'
import { shownGroups } from '../contextMenu'
import { t } from '../i18n'
import {
  PREVIEW_MENU,
  firstCharacter,
  openableHref,
  previewMenuTarget,
  type PreviewMenuTarget,
} from './previewMenu'

const groupsFor = (target: PreviewMenuTarget) =>
  shownGroups(PREVIEW_MENU, target).map((group) =>
    group.map((entry) =>
      entry.predefined ? entry.predefined : (entry.text?.(target) ?? t(entry.label as never)),
    ),
  )

describe('the preview menu', () => {
  it('has Select All and Speech without a link or a selection', () => {
    expect(groupsFor({ link: null, selection: null })).toEqual([['Copy', 'Select All'], ['Speech']])
  })

  it('adds Copy Link Address on a link and Look Up with a selection', () => {
    expect(groupsFor({ link: 'https://example.com', selection: 'hello' })).toEqual([
      ['Copy Link Address'],
      ['Look Up “hello”'],
      ['Copy', 'Select All'],
      ['Speech'],
    ])
  })
})

describe('the links the menu copies', () => {
  it('are web pages and notes only', () => {
    expect(openableHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(openableHref('devot://note/0b9c1b1a-0000-4000-8000-000000000000')).toContain('devot://')
    for (const href of [
      'http://example.com',
      'javascript:alert(1)',
      'file:///etc/passwd',
      '#top',
      '',
    ]) {
      expect(openableHref(href)).toBeNull()
    }
    expect(openableHref(null)).toBeNull()
  })

  it('come from the link element, with the selection trimmed', () => {
    const link = { getAttribute: (name: string) => (name === 'href' ? 'https://e.com' : null) }
    expect(previewMenuTarget(link as unknown as Element, '  word \n')).toEqual({
      link: 'https://e.com',
      selection: 'word',
    })
    expect(previewMenuTarget(null, '   ')).toEqual({ link: null, selection: null })
    expect(previewMenuTarget(null, undefined)).toEqual({ link: null, selection: null })
  })
})

describe('the character Look Up starts at in the preview', () => {
  it('skips white space, across runs, from the start of the selected part', () => {
    expect(firstCharacter([{ text: 'one two', start: 3, end: 7 }])).toEqual({
      run: 0,
      offset: 4,
      length: 1,
    })
    expect(
      firstCharacter([
        { text: 'end  ', start: 3, end: 5 },
        { text: '\n', start: 0, end: 1 },
        { text: ' next', start: 0, end: 3 },
      ]),
    ).toEqual({ run: 2, offset: 1, length: 1 })
  })

  it('takes a surrogate pair whole', () => {
    expect(firstCharacter([{ text: ' \u{1d400}b', start: 0, end: 4 }])).toEqual({
      run: 0,
      offset: 1,
      length: 2,
    })
  })

  it('is null for white space or nothing', () => {
    expect(firstCharacter([{ text: 'word  ', start: 4, end: 6 }])).toBeNull()
    expect(firstCharacter([{ text: 'word', start: 2, end: 2 }])).toBeNull()
    expect(firstCharacter([])).toBeNull()
  })
})
