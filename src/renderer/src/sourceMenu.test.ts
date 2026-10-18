import { describe, expect, it } from 'vitest'
import { menuLines } from './menuLines'
import { ALL_NOTES_MENU, FILTER_ROW_MENU, TRASH_ROW_MENU } from './sourceMenu'

describe('TRASH_ROW_MENU', () => {
  it('offers Empty Trash with an ellipsis while the Trash has notes', async () => {
    const { lines } = await menuLines('trashRow', TRASH_ROW_MENU, { notes: 2 })
    expect(lines).toEqual(['Empty Trash…'])
  })

  it('shows nothing for an empty Trash', async () => {
    const { lines } = await menuLines('trashRow', TRASH_ROW_MENU, { notes: 0 })
    expect(lines).toEqual([])
  })

  it('picks emptyTrash', async () => {
    const picked: string[] = []
    const { click } = await menuLines('trashRow', TRASH_ROW_MENU, { notes: 1 }, (a) =>
      picked.push(a),
    )
    click('devot.trashRow.emptyTrash')
    expect(picked).toEqual(['emptyTrash'])
  })
})

describe('ALL_NOTES_MENU', () => {
  it('offers Show Notes, then New Note with its key', async () => {
    const { lines } = await menuLines('allNotes', ALL_NOTES_MENU, { canCreate: true })
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('Show Notes')
    expect(lines[1]).toBe('---')
    expect(lines[2]).toMatch(/^New Note \S+$/)
  })
})

it('leaves out New Note while no note can be made', async () => {
  const { lines } = await menuLines('allNotes', ALL_NOTES_MENU, { canCreate: false })
  expect(lines).toEqual(['Show Notes'])
})

describe('FILTER_ROW_MENU', () => {
  it('is a checked item named for the row, checked while the row filters', async () => {
    const status = await menuLines('filterRow', FILTER_ROW_MENU, {
      filter: { kind: 'status', status: 'active' },
      filtered: false,
    })
    expect(status.lines).toEqual(['Filter by Status [ ]'])
    const pinned = await menuLines('filterRow', FILTER_ROW_MENU, {
      filter: { kind: 'pinned' },
      filtered: true,
    })
    expect(pinned.lines).toEqual(['Show Pinned Notes [x]'])
  })
})
