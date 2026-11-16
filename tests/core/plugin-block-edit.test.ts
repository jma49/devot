import { describe, expect, it } from 'vitest'
import { editedBlock } from '../../src/core/plugins/blockEdit'

describe('editedBlock', () => {
  it('puts new content in the block’s own fence', () => {
    expect(editedBlock('```sketch {x}\nold\n```', 'old', 'a\n\nb')).toBe(
      '```sketch {x}\na\n\nb\n```',
    )
    expect(editedBlock('~~~~sketch\nold\n~~~~', 'old', 'new')).toBe('~~~~sketch\nnew\n~~~~')
  })

  it('keeps the block inside its list item or quote', () => {
    expect(editedBlock('```sketch\n  old\n  ```', 'old', 'a\n\nb')).toBe(
      '```sketch\n  a\n\n  b\n  ```',
    )
    expect(editedBlock('```sketch\n> old\n>\n> x\n> ```', 'old\n\nx', 'new')).toBe(
      '```sketch\n> new\n> ```',
    )
  })

  it('lengthens the fence when the content holds one as long', () => {
    expect(editedBlock('```sketch\nold\n```', 'old', 'a ``` b')).toBe('````sketch\na ``` b\n````')
  })

  it('closes a block the note left open', () => {
    expect(editedBlock('```sketch\nold', 'old', 'new')).toBe('```sketch\nnew\n```')
  })

  it('refuses a block whose content changed, or what is no fenced block', () => {
    expect(editedBlock('```sketch\nolder\n```', 'old', 'new')).toBeNull()
    expect(editedBlock('    old', 'old', 'new')).toBeNull()
    expect(editedBlock('```sketch\n  old\n```', 'old', 'new')).toBeNull()
  })
})
