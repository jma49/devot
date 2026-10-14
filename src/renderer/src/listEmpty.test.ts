import { describe, expect, it } from 'vitest'
import { en } from './i18n/en'
import { LIST_EMPTY_KINDS, listEmpty } from './listEmpty'

describe('the empty note list', () => {
  it('has a message from the catalog for every view', () => {
    const keys = LIST_EMPTY_KINDS.flatMap((kind) => {
      const { message, tip } = listEmpty(kind)
      return tip ? [message, tip] : [message]
    })
    expect(keys.filter((key) => !en[key])).toEqual([])
  })

  it('says why the list is empty', () => {
    expect(en[listEmpty('trash').message]).toBe('Trash Is Empty')
    expect(en[listEmpty('search').message]).toBe('No Matching Notes')
    expect(listEmpty('notebook').tip).toBe('noteList.empty.createTip')
  })
})
