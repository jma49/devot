import { describe, expect, it } from 'vitest'
import { clearDraft, isEmptyCapture, notebookToShow, readDraft, writeDraft } from './draft'
import { memoryStorage } from '../../../../tests/support/local-storage'

describe('the quick capture draft', () => {
  it('is kept as it is typed and read back when the window opens again', () => {
    const storage = memoryStorage()
    expect(readDraft(storage)).toBeNull()
    writeDraft({ title: 'Call', body: 'about the lease', bookId: 'b1' }, storage)
    expect(readDraft(storage)).toEqual({ title: 'Call', body: 'about the lease', bookId: 'b1' })
    writeDraft({ title: '', body: 'x', bookId: null }, storage)
    expect(readDraft(storage)).toEqual({ title: '', body: 'x', bookId: null })
  })

  it('is cleared once its note is saved, or when it holds nothing', () => {
    const storage = memoryStorage()
    writeDraft({ title: 'Call', body: '', bookId: null }, storage)
    clearDraft(storage)
    expect(readDraft(storage)).toBeNull()
    writeDraft({ title: 'Call', body: '', bookId: null }, storage)
    writeDraft({ title: '', body: '', bookId: 'b1' }, storage)
    expect(storage.items.size).toBe(0)
  })

  it('reads a damaged draft as none', () => {
    for (const stored of ['{', '[]', '{"title":1,"body":"","bookId":null}', '{"title":"a"}']) {
      const storage = memoryStorage()
      storage.setItem('devot.quickCapture.draft', stored)
      expect(readDraft(storage)).toBeNull()
    }
  })

  it('loses nothing when storage is off', () => {
    const off = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {
        throw new Error('SecurityError')
      },
    }
    expect(readDraft(off)).toBeNull()
    expect(() => writeDraft({ title: 'a', body: '', bookId: null }, off)).not.toThrow()
    expect(() => clearDraft(off)).not.toThrow()
  })
})

describe('isEmptyCapture', () => {
  it('counts white space as nothing', () => {
    expect(isEmptyCapture({ title: ' ', body: '\n\t' })).toBe(true)
    expect(isEmptyCapture({ title: 'a', body: '' })).toBe(false)
    expect(isEmptyCapture({ title: '', body: 'b' })).toBe(false)
  })
})

describe('notebookToShow', () => {
  const ids = ['b1', 'b2']

  it("keeps the draft's notebook while it exists, no notebook included", () => {
    expect(notebookToShow('b2', 'b1', ids)).toBe('b2')
    expect(notebookToShow(null, 'b1', ids)).toBeNull()
  })

  it('starts at the default notebook, else none', () => {
    expect(notebookToShow(undefined, 'b1', ids)).toBe('b1')
    expect(notebookToShow(undefined, null, ids)).toBeNull()
  })

  it('falls back when the chosen notebook is gone', () => {
    expect(notebookToShow('gone', 'b1', ids)).toBe('b1')
    expect(notebookToShow('gone', 'also-gone', ids)).toBeNull()
  })
})
