import { describe, expect, it } from 'vitest'
import { ICONS } from './symbols'
import { LUCIDE_FILLS, LUCIDE_ICONS } from './lucide'

describe('the Lucide icon set', () => {
  it('maps exactly the icons that symbols.json names', () => {
    expect(Object.keys(LUCIDE_ICONS).sort()).toEqual([...ICONS].sort())
  })

  it('fills only icons that exist', () => {
    for (const name of Object.keys(LUCIDE_FILLS)) expect(ICONS).toContain(name)
  })
})
