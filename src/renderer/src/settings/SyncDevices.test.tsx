// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PairingRow } from './SyncDevices'
import { mockTauri } from '../../../../tests/support/tauri-events'

vi.hoisted(() => {
  vi.stubGlobal('DEVOT_UI_TEST', false)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})

const PAIRING_EVENT = 'devot://sync-pairing'
const ICLOUD_POLL_MS = 10_000

let tauri: ReturnType<typeof mockTauri>
let answering: ((answer: unknown) => void)[] = []
let root: Root | undefined
let host: HTMLElement | undefined

beforeEach(() => {
  vi.useFakeTimers()
  answering = []
  tauri = mockTauri((cmd) => {
    switch (cmd) {
      case 'sync_pairing_open':
        return {
          code: Array.from({ length: 8 }, () => 'ABCD').join('-'),
          link: 'devot://pair?code=ABCD',
          qr: { size: 1, modules: '1' },
          expires: Date.now() + 600_000,
        }
      case 'sync_pairing_check':
        return new Promise((resolve) => answering.push(resolve))
      default:
        return null
    }
  })
})

afterEach(() => {
  if (root) act(() => root?.unmount())
  host?.remove()
  root = undefined
  tauri.clear()
  vi.useRealTimers()
})

const pass = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms))
const checks = () => tauri.invoked.filter((cmd) => cmd === 'sync_pairing_check').length
const answerAll = async (state: string) => {
  for (const answer of answering.splice(0)) answer({ state })
  await pass()
}
const button = (text: string) =>
  [...(host?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === text)

async function showCode() {
  host = document.createElement('div')
  document.body.append(host)
  const r = createRoot(host)
  root = r
  const none = () => undefined
  act(() =>
    r.render(
      <PairingRow
        icloud
        locked={false}
        focusRequest={0}
        onDevicesChanged={none}
        onAnnounce={none}
        failed={() => none}
      />,
    ),
  )
  await act(async () => button('Show Pairing Code')?.click())
  await pass()
  await pass()
  expect(tauri.listening(PAIRING_EVENT)).toBe(1)
}

it('keeps one iCloud poll loop when a push lands while a check is in flight, and none after Cancel', async () => {
  await showCode()
  await pass(ICLOUD_POLL_MS)
  expect(checks()).toBe(1)
  tauri.emit(PAIRING_EVENT)
  await pass()
  expect(checks()).toBe(1)
  await answerAll('waiting')
  for (let round = 2; round <= 4; round++) {
    await pass(ICLOUD_POLL_MS)
    expect(checks()).toBe(round)
    await answerAll('waiting')
  }
  await act(async () => button('Cancel')?.click())
  await pass(ICLOUD_POLL_MS * 3)
  expect(checks()).toBe(4)
})

it('checks at once on a push between checks, and waits the full interval after it', async () => {
  await showCode()
  await pass(ICLOUD_POLL_MS / 2)
  tauri.emit(PAIRING_EVENT)
  await pass()
  expect(checks()).toBe(1)
  await answerAll('waiting')
  await pass(ICLOUD_POLL_MS - 1)
  expect(checks()).toBe(1)
  await pass(1)
  expect(checks()).toBe(2)
})

it('sends no check once the code was cancelled with a check in flight', async () => {
  await showCode()
  await pass(ICLOUD_POLL_MS)
  expect(checks()).toBe(1)
  await act(async () => button('Cancel')?.click())
  await answerAll('waiting')
  tauri.emit(PAIRING_EVENT)
  await pass(ICLOUD_POLL_MS * 3)
  expect(checks()).toBe(1)
})
