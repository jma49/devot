import { describe, expect, it } from 'vitest'
import { effectiveKeymap } from '../commands/keymap'
import { COMMANDS } from '../commands/registry'
import { matchesQuery } from './shortcutSearch'

const keymap = effectiveKeymap({})
/** The IDs of the commands a search leaves in the table. */
const found = (query: string, map = keymap) =>
  COMMANDS.filter((c) => matchesQuery(c, map.get(c.id) ?? [], query)).map((c) => c.id)

describe('the keyboard search', () => {
  it('leaves every command for an empty search', () => {
    expect(found('')).toHaveLength(COMMANDS.length)
    expect(found('   ')).toHaveLength(COMMANDS.length)
  })

  it('narrows the table to the commands whose name has every word', () => {
    expect(found('bold')).toEqual(['format.bold'])
    expect(found('BOLD')).toEqual(['format.bold'])
    expect(found('heading 3')).toEqual(['format.heading3'])
    expect(found('no such command')).toEqual([])
    expect(found('bold').length).toBeLessThan(COMMANDS.length)
  })

  it('finds a command by its key, as shown or as written', () => {
    expect(found('shift+enter')).toContain('edit.plainNewline')
    expect(found('mod+u')).toEqual(['format.strikethrough'])
    expect(found('⌘U')).toContain('format.strikethrough')
    expect(found('f5')).toEqual([
      'edit.sortLines',
      'edit.sortLinesReverse',
      'edit.sortLinesCase',
      'edit.sortLinesCaseReverse',
    ])
  })

  it('reads the keys in effect, not the defaults', () => {
    const moved = effectiveKeymap({ 'format.bold': ['Mod+Alt+J'] })
    expect(found('mod+alt+j', moved)).toEqual(['format.bold'])
    expect(found('mod+b', moved)).not.toContain('format.bold')
  })

  it('finds the commands of a group by its name', () => {
    expect(found('tables')).toEqual(COMMANDS.filter((c) => c.group === 'table').map((c) => c.id))
  })
})
