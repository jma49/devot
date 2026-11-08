// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { invoke } from './ipc'
import { readCurrentLicence } from './licence'
import { TrialReminder } from './TrialNotices'

vi.mock('./ipc', () => ({ invoke: vi.fn<() => Promise<unknown>>() }))
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const HOUR = 3_600_000
const REMINDED_KEY = 'devot.trial.reminded'
let trials = 0
let endsAt = 0
const lastDay = () => ({
  gated: true,
  state: 'none',
  code: null,
  id: null,
  licensee: null,
  plan: null,
  activation: null,
  appStore: null,
  trial: { state: 'running', endsAt, code: null, source: 'keychain' },
})

let host: HTMLDivElement
let root: Root

const shown = () => host.querySelector('[data-devot-trial-reminder]') !== null

beforeEach(async () => {
  // Each test's trial ends at another moment, as a dismissal kept in memory outlives the test.
  endsAt = Date.now() + 2 * HOUR + ++trials
  localStorage.removeItem(REMINDED_KEY)
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === 'licence_get' ? lastDay() : undefined,
  )
  await readCurrentLicence()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  localStorage.removeItem(REMINDED_KEY)
  vi.mocked(invoke).mockReset()
  vi.restoreAllMocks()
})

it('goes away when another window dismisses it after this one did', async () => {
  vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
    throw new Error('QuotaExceededError')
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  act(() => root.render(<TrialReminder />))
  act(() => [...host.querySelectorAll('button')].at(-1)!.click())
  act(() => root.render(<></>))
  endsAt += HOUR
  await readCurrentLicence()
  act(() => root.render(<TrialReminder />))
  expect(shown()).toBe(true)
  act(() => {
    localStorage.setItem(REMINDED_KEY, String(endsAt))
    window.dispatchEvent(new StorageEvent('storage', { key: REMINDED_KEY }))
  })
  expect(shown()).toBe(false)
})

it('goes away when another window dismisses it', () => {
  act(() => root.render(<TrialReminder />))
  expect(shown()).toBe(true)
  act(() => {
    localStorage.setItem(REMINDED_KEY, String(endsAt))
    window.dispatchEvent(new StorageEvent('storage', { key: REMINDED_KEY }))
  })
  expect(shown()).toBe(false)
})

it('goes away from every copy in this window when one is dismissed', () => {
  act(() =>
    root.render(
      <>
        <TrialReminder />
        <TrialReminder />
      </>,
    ),
  )
  const reminders = host.querySelectorAll('[data-devot-trial-reminder]')
  expect(reminders).toHaveLength(2)
  const dismiss = [...reminders[0]!.querySelectorAll('button')].at(-1)!
  act(() => dismiss.click())
  expect(shown()).toBe(false)
  expect(localStorage.getItem(REMINDED_KEY)).toBe(String(endsAt))
})

it('stays dismissed in this window when storage refuses the write', () => {
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new Error('QuotaExceededError')
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  act(() => root.render(<TrialReminder />))
  act(() => [...host.querySelectorAll('button')].at(-1)!.click())
  expect(localStorage.getItem(REMINDED_KEY)).toBeNull()
  expect(shown()).toBe(false)
})
