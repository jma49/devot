import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from './ipc'
import { licenceSnapshot, readCurrentLicence, subscribeLicence, trialRunning } from './licence'

vi.mock('./ipc', () => ({ invoke: vi.fn<() => Promise<unknown>>() }))

const START = new Date(2026, 9, 24, 9, 0).getTime()
const END = START + 60_000

const running = (endsAt: number) => ({
  gated: true,
  state: 'none',
  code: null,
  id: null,
  licensee: null,
  plan: null,
  trial: { state: 'running', endsAt, code: null },
})

describe('the end of the trial in a window', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: START })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('tells the window once at the end and does not look again until Rust does', async () => {
    vi.mocked(invoke).mockResolvedValue(running(END))
    await readCurrentLicence()
    let told = 0
    const stop = subscribeLicence(() => told++)

    vi.advanceTimersByTime(END - START - 1)
    expect(told).toBe(0)
    vi.advanceTimersByTime(1)
    expect(told).toBe(1)
    expect(trialRunning(licenceSnapshot(), Date.now())).toBe(false)

    vi.advanceTimersByTime(60_000)
    expect(told).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    stop()
  })

  it('sets no timer for a trial whose end has already passed', async () => {
    vi.mocked(invoke).mockResolvedValue(running(START - 1))
    await readCurrentLicence()
    expect(vi.getTimerCount()).toBe(0)
  })
})
