import { expect, it } from 'vitest'
import { listCaption } from '../../src/renderer/src/format'

it('says when a search matched more notes than it shows', () => {
  expect(listCaption(200, undefined, 'en')).toBe('200 notes')
  expect(listCaption(200, undefined, 'en', true)).toBe('More than 200 notes')
  expect(listCaption(200, 'Work', 'en', true)).toBe('Work · More than 200 notes')
})
