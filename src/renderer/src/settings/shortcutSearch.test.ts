import { describe, expect, it } from 'vitest'
import { effectiveKeymap } from '../commands/keymap'
import { COMMANDS } from '../commands/registry'
import { GROUP_ORDER, groupedShortcuts, matchesQuery } from './shortcutSearch'

const keymap = effectiveKeymap({})
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

  it('reads cmd, command, ctrl, control, opt, option, alt and shift in a typed key, in any order', () => {
    expect(found('cmd+k')).toEqual(found('mod+k'))
    expect(found('cmd+k')).toContain('palette.open')
    expect(found('CMD+K')).toEqual(found('mod+k'))
    expect(found('command+u')).toEqual(['format.strikethrough'])
    expect(found('shift+cmd+d')).toEqual(found('mod+shift+d'))
    expect(found('opt+cmd+y')).toEqual(found('mod+alt+y'))
    expect(found('option+cmd+y')).toEqual(found('mod+alt+y'))
    expect(found('control+cmd+1')).toEqual(found('mod+ctrl+1'))
    expect(found('ctrl+cmd+1').length).toBeGreaterThan(0)
    // A typed key names that key alone, not every key that has it inside.
    expect(found('cmd+k')).not.toContain(
      COMMANDS.find((c) => keymap.get(c.id)?.includes('Mod+Shift+K'))?.id,
    )
  })
})

describe('the keyboard groups', () => {
  it('orders every group once, app first', () => {
    expect(GROUP_ORDER).toEqual([
      'app',
      'note',
      'notebook',
      'tag',
      'view',
      'search',
      'find',
      'edit',
      'format',
      'table',
      'image',
    ])
    expect(new Set(COMMANDS.map((c) => c.group))).toEqual(new Set(GROUP_ORDER))
  })

  it('lists every command under its group, in the group order, keeping the registry order', () => {
    const groups = groupedShortcuts(COMMANDS, keymap, '')
    expect(groups.map((g) => g.group)).toEqual(GROUP_ORDER)
    for (const { group, commands } of groups)
      expect(commands.map((c) => c.id)).toEqual(
        COMMANDS.filter((c) => c.group === group).map((c) => c.id),
      )
  })

  it('leaves out a group the search empties, and every group when nothing matches', () => {
    expect(groupedShortcuts(COMMANDS, keymap, 'bold')).toEqual([
      { group: 'format', commands: [COMMANDS.find((c) => c.id === 'format.bold')] },
    ])
    expect(groupedShortcuts(COMMANDS, keymap, 'no such command')).toEqual([])
  })
})
