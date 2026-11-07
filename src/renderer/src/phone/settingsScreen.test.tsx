// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '../ipc'
import { readCurrentLicence } from '../licence'
import { PhoneSettings } from './PhoneSettings'

vi.mock('../ipc', () => ({ invoke: vi.fn<() => Promise<unknown>>() }))
vi.stubGlobal('DEVOT_UI_TEST', true)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const DAY = 24 * 60 * 60 * 1000
const START = Date.UTC(2026, 10, 6, 9)

const trialSnapshot = (endsAt: number) => ({
  gated: true,
  state: 'none',
  code: null,
  id: null,
  licensee: null,
  plan: null,
  trial: { state: 'running', endsAt, code: null, source: 'keychain' },
  activation: null,
  appStore: null,
})

let host: HTMLDivElement
let root: Root
let onOpenPane: (pane: string) => void

beforeEach(() => {
  vi.mocked(invoke).mockResolvedValue(undefined)
  onOpenPane = vi.fn<(pane: string) => void>()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.mocked(invoke).mockReset()
  vi.useRealTimers()
})

async function settings(trialEndsAt = START + 20 * DAY) {
  vi.mocked(invoke).mockResolvedValueOnce(trialSnapshot(trialEndsAt))
  await readCurrentLicence()
  act(() => root.render(<PhoneSettings onOpenPane={onOpenPane} />))
}

const button = (name: string) =>
  [...host.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === name || b.textContent?.includes(name),
  )

function search(query: string) {
  act(() => button('Search Settings')?.click())
  const input = host.querySelector<HTMLInputElement>('input[type="search"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, query)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const results = () =>
  [...host.querySelectorAll('.phone-settings-search .phone-grouped-open')].map(
    (row) => row.textContent,
  )

describe('Settings search on an iPhone', () => {
  it('finds a single setting by its name and opens the pane it is in', async () => {
    await settings()
    search('line numbers')
    expect(results()).toEqual(['Line NumbersEditing'])
    act(() => button('Line Numbers')?.click())
    expect(onOpenPane).toHaveBeenCalledWith('editing')
  })

  it('finds nothing the iPhone does not show', async () => {
    await settings()
    search('synced scrolling')
    expect(results()).toEqual([])
    expect(host.textContent).toContain('No matching settings')
  })

  it('lists every pane before anything is typed', async () => {
    await settings()
    search('')
    expect(results()).toEqual([
      'General',
      'Appearance',
      'Editing',
      'Preview',
      'Sync',
      'AI',
      'License',
    ])
  })
})

describe('the trial days on the iPhone Settings screen', () => {
  const shown = () => host.textContent?.match(/Trial, (\d+) days left/)?.[1]

  it('count down while the screen stays open', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(START)
    await settings(START + 2.5 * DAY)
    expect(shown()).toBe('3')
    await act(async () => vi.advanceTimersByTime(DAY / 2 - 1))
    expect(shown()).toBe('3')
    await act(async () => vi.advanceTimersByTime(1))
    expect(shown()).toBe('2')
    await act(async () => vi.advanceTimersByTime(DAY))
    expect(shown()).toBe('1')
  })

  it('read the clock again when the app comes back to the foreground', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(START)
    await settings(START + 10 * DAY)
    expect(shown()).toBe('10')
    vi.setSystemTime(START + 3 * DAY)
    expect(shown()).toBe('10')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(shown()).toBe('7')
  })
})
