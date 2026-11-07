import { describe, expect, it } from 'vitest'
import { datesEdit, sectionOpen, setSectionOpen } from './infoCard'
import { memoryStorage } from '../../../../tests/support/local-storage'

const info = {
  createdAt: new Date(2026, 9, 13, 1, 43, 54).getTime(),
  updatedAt: new Date(2026, 9, 13, 1, 57, 24).getTime(),
}

describe('the card’s folds', () => {
  it('start open and remember each section’s last choice', () => {
    const storage = memoryStorage()
    expect(sectionOpen('properties', storage)).toBe(true)
    expect(sectionOpen('backlinks', storage)).toBe(true)
    setSectionOpen('backlinks', false, storage)
    expect(sectionOpen('backlinks', storage)).toBe(false)
    expect(sectionOpen('properties', storage)).toBe(true)
    setSectionOpen('backlinks', true, storage)
    expect(sectionOpen('backlinks', storage)).toBe(true)
  })

  it('read as open when storage is unavailable', () => {
    expect(sectionOpen('properties', undefined)).toBe(true)
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(sectionOpen('properties', broken)).toBe(true)
    expect(() => setSectionOpen('properties', false, broken)).not.toThrow()
  })
})

describe('setting a date on the card', () => {
  it('keeps a note created no later than it was updated', () => {
    expect(datesEdit(info, 'created', info.updatedAt)).toEqual({ createdAt: info.updatedAt })
    expect(datesEdit(info, 'created', info.updatedAt + 1)).toBeNull()
    expect(datesEdit(info, 'updated', info.createdAt)).toEqual({ updatedAt: info.createdAt })
    expect(datesEdit(info, 'updated', info.createdAt - 1)).toBeNull()
  })
})
