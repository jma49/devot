import { describe, expect, it } from 'vitest'
import { shownGroups } from '../contextMenu'
import { t } from '../i18n'
import {
  PREVIEW_MENU,
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
