import { expect, it } from 'vitest'
import { untilTime, uploadCounts } from '../../src/renderer/src/format'
import { readSnapshot } from '../../src/renderer/src/sync'

const snapshot = (status: Record<string, unknown>) =>
  readSnapshot({ relayUrl: 'https://relay.example.test', enabled: true, status })?.status

it('reads a quota pause, an upload and a relay to update from Rust’s snapshot', () => {
  expect(
    snapshot({
      state: 'paused',
      code: 'E_SYNC_QUOTA',
      pausedUntil: Date.UTC(2026, 9, 24),
      upload: { sent: 3, total: 9 },
      relayOutdated: true,
    }),
  ).toMatchObject({
    pausedUntil: Date.UTC(2026, 9, 24),
    upload: { sent: 3, total: 9 },
    relayOutdated: true,
  })
})

it('drops a pause outside the paused state and an upload that does not add up', () => {
  for (const upload of [
    { sent: 10, total: 9 },
    { sent: -1, total: 9 },
    { sent: 0, total: 0 },
    'x',
  ]) {
    expect(snapshot({ state: 'idle', pausedUntil: 5, upload })).toMatchObject({
      pausedUntil: null,
      upload: null,
      relayOutdated: false,
    })
  }
})

it('says the reset’s local time, with the weekday when it is another day here', () => {
  const reset = Date.UTC(2026, 9, 24)
  const at = new Date(reset)
  const time = new Intl.DateTimeFormat('en-US', { timeStyle: 'short' }).format(reset)
  const sameDay = new Date(at.getFullYear(), at.getMonth(), at.getDate(), 0, 0).getTime()
  expect(untilTime(reset, sameDay, 'en-US')).toBe(time)
  expect(untilTime(reset, sameDay - 86_400_000, 'en-US')).toMatch(/^[A-Z][a-z]+day/)
  expect(uploadCounts({ sent: 20_000, total: 45_000 }, 'en-US')).toEqual({
    sent: '20,000',
    total: '45,000',
  })
})
