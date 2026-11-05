// The main window's sync notice words a pause by the transport: never the relay's quota on iCloud.
import { expect, it } from 'vitest'
import { syncNoticeMessages } from '../../src/renderer/src/syncNoticeText'
import { SYNC_OFF, type SyncSnapshot } from '../../src/renderer/src/sync'

const paused = (
  transport: SyncSnapshot['transport'],
  code: string,
  pausedUntil: number | null,
): SyncSnapshot => ({
  ...SYNC_OFF,
  enabled: true,
  transport,
  status: { ...SYNC_OFF.status, state: 'paused', code, pausedUntil },
})

const later = Date.now() + 3_600_000

it('words every iCloud pause, timed or not, without the relay’s quota', () => {
  for (const [code, until] of [
    ['E_SYNC_ICLOUD_BUSY', later],
    ['E_SYNC_ICLOUD_SIGNED_OUT', null],
    ['E_SYNC_ICLOUD_RESTRICTED', null],
    ['E_SYNC_ICLOUD_FULL', null],
  ] as const) {
    for (const pauseOver of [false, true]) {
      const [text, ...rest] = syncNoticeMessages(paused('icloud', code, until), pauseOver, null)
      expect(rest).toEqual([])
      expect(text).toContain('iCloud')
      expect(text).not.toMatch(/relay|quota/i)
    }
  }
})

it('keeps the relay’s quota wording on a relay', () => {
  const [text] = syncNoticeMessages(paused('relay', 'E_SYNC_QUOTA', later), false, null)
  expect(text).toMatch(/quota for today/)
})
