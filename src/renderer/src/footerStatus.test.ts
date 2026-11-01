import { describe, expect, it } from 'vitest'
import { footerStatus } from './footerStatus'

const MIRROR_ON = { folder: '/Users/me/Notes', paused: null }
const MIRROR_OFF = { folder: null, paused: null }
const BACKED_UP = { kind: 'ready', count: 3, lastError: null } as const

describe('footerStatus', () => {
  it('reads backed up with the mirror on as all well', () => {
    expect(footerStatus(BACKED_UP, MIRROR_ON)).toEqual({
      tone: 'ok',
      text: 'Backed up · Mirror on',
    })
  })

  it('keeps a mirror that is off from reading as a problem', () => {
    expect(footerStatus(BACKED_UP, MIRROR_OFF)).toEqual({
      tone: 'ok',
      text: 'Backed up · Mirror off',
    })
  })

  it('warns while there is no backup yet or the mirror is paused', () => {
    expect(footerStatus({ kind: 'ready', count: 0, lastError: null }, MIRROR_ON)).toEqual({
      tone: 'warn',
      text: 'Not backed up yet · Mirror on',
    })
    expect(footerStatus(BACKED_UP, { folder: '/x', paused: 'E_MIRROR_MISSING' })).toEqual({
      tone: 'warn',
      text: 'Backed up · Mirror paused',
    })
  })

  it('shows a failed backup, or a list that could not be read, as an error', () => {
    expect(footerStatus({ kind: 'ready', count: 3, lastError: 'E_X' }, MIRROR_ON)).toEqual({
      tone: 'error',
      text: 'Backup failed · Mirror on',
    })
    expect(footerStatus({ kind: 'failed' }, MIRROR_OFF)).toEqual({
      tone: 'error',
      text: 'Backup failed · Mirror off',
    })
  })

  it('has nothing to say until the backups are known', () => {
    expect(footerStatus({ kind: 'loading' }, MIRROR_ON)).toBeUndefined()
  })
})
