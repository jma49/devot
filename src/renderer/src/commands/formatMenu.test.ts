import { describe, expect, it } from 'vitest'
import { isEcho } from './formatMenu'
import { formatMenuKeys, isFormatMenuCommand } from './registry'

describe('Format menu', () => {
  it('runs only format commands', () => {
    expect(isFormatMenuCommand('format.italic')).toBe(true)
    expect(isFormatMenuCommand('format.alertCaution')).toBe(true)
    for (const other of ['note.new', 'palette.open', 'format.nope', 'format.', '', 42, null]) {
      expect(isFormatMenuCommand(other)).toBe(false)
    }
  })

  it('skips a menu event for the format the editor keys just ran', () => {
    const at = 1000
    const ran = { format: 'italic', at } as const
    expect(isEcho('format.italic', ran, at + 50)).toBe(true)
    // Long after, another format, or no key at all: a pick of its own.
    expect(isEcho('format.italic', ran, at + 5000)).toBe(false)
    expect(isEcho('format.bold', ran, at + 50)).toBe(false)
    expect(isEcho('format.italic', undefined, at)).toBe(false)
  })

  it('takes the keys of the formats that do nothing off the menu', () => {
    const all = formatMenuKeys()
    expect(all['format.italic']).toBe('CmdOrCtrl+I')
    const keys = formatMenuKeys(new Set(['italic', 'bold']))
    expect(keys['format.italic']).toBeUndefined()
    expect(keys['format.bold']).toBeUndefined()
    expect(keys['format.strikethrough']).toBe(all['format.strikethrough'])
    expect(Object.keys(keys)).toHaveLength(Object.keys(all).length - 2)
  })
})
