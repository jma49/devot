import { describe, expect, it } from 'vitest'
import { menuLines } from './menuLines'
import { TRASH_NOTE_MENU } from './trashMenu'

describe('TRASH_NOTE_MENU', () => {
  it('offers Restore and Delete Permanently for one note', async () => {
    const { lines } = await menuLines('trash', TRASH_NOTE_MENU, { id: 'n', count: 1 })
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('Restore from Trash')
    expect(lines[1]).toBe('---')
    expect(lines[2]).toMatch(/^Delete Permanently /)
  })

  it('says so when it acts on a selection', async () => {
    const { lines } = await menuLines('trash', TRASH_NOTE_MENU, { id: 'n', count: 3 })
    expect(lines[0]).toBe('Restore Selected Notes')
    expect(lines[2]).toMatch(/^Delete Selected Notes Permanently /)
  })

  it('picks the Trash actions', async () => {
    const picked: string[] = []
    const { click } = await menuLines('trash', TRASH_NOTE_MENU, { id: 'n', count: 1 }, (a) =>
      picked.push(a),
    )
    click('devot.trash.restore')
    click('devot.trash.deleteForever')
    expect(picked).toEqual(['restore', 'deleteForever'])
  })
})
