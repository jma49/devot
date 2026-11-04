import { expect, it } from 'vitest'
import { changeMessage } from '../../src/renderer/src/changeMessage'

it('says why a tag rename that would overfill a saved search is refused', () => {
  const message = changeMessage('E_TAG_RENAME_SEARCH_TOO_LONG')
  expect(message).toContain('saved search')
  expect(message).toContain('1,000')
  expect(message).toContain('E_TAG_RENAME_SEARCH_TOO_LONG')
})

it('falls back to the generic notice for other codes', () => {
  expect(changeMessage('E_OTHER')).toContain('E_OTHER')
})

it('says a note left the Trash before it could be deleted, without the code', () => {
  const message = changeMessage('E_NOTE_NOT_TRASHED')
  expect(message).toContain('Trash')
  expect(message).not.toContain('E_NOTE_NOT_TRASHED')
})
