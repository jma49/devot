import { describe, expect, it } from 'vitest'
import { SYNC_OFF, type SyncSnapshot } from './sync'
import { syncNoticeMessages } from './syncNoticeText'

const stopped = (code: string): SyncSnapshot => ({
  ...SYNC_OFF,
  enabled: true,
  enrolled: true,
  vault: true,
  status: { ...SYNC_OFF.status, state: 'stopped', code },
})

describe('syncNoticeMessages', () => {
  it('words a stop Devot can explain without its code', () => {
    const [text] = syncNoticeMessages(stopped('E_SYNC_PROTOCOL'), false, null)
    expect(text).toBe('Sync has stopped. Update Devot and your relay to the same release.')
  })

  it('keeps the code in a stop it cannot explain', () => {
    const [text] = syncNoticeMessages(stopped('E_SYNC_UNEXPLAINED'), false, null)
    expect(text).toContain('E_SYNC_UNEXPLAINED')
  })
})
