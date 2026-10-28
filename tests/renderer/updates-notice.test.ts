// After Later on an available update, a check the same window asks for again must show the notice
// with Download, even for the same version: its key carries the check's revision (A058).
import { describe, expect, it } from 'vitest'
import { updateNotice, type UpdateStatus } from '../../src/renderer/src/updates'

const available = (revision: number, askedBy: string | null): UpdateStatus => ({
  state: 'available',
  version: '1.4.0',
  revision,
  current: '1.3.0',
  enabled: true,
  askedBy,
})

describe('the notice for an available update', () => {
  it('is a new thing to say when this window asks again, so Later does not hide it', () => {
    const first = updateNotice(available(4, 'main'), 'main')
    const again = updateNotice(available(9, 'main'), 'main')
    expect(first?.key).toBe('available:1.4.0:4')
    expect(again?.key).toBe('available:1.4.0:9')
    expect(again?.action).toBe('download')
  })

  it('is unchanged by another window’s check of the same version', () => {
    const before = updateNotice(available(4, 'main-2'), 'main')
    const after = updateNotice(available(9, 'main-2'), 'main')
    expect(before?.key).toBe('available:1.4.0')
    expect(after?.key).toBe(before?.key)
  })
})
