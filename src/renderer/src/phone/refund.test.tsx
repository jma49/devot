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

const ID = '5vEvzHainWD0cA2Ht_ljHg'

const snapshot = (appStore: { pro: boolean } | null, licensed = false) => ({
  gated: true,
  state: licensed ? 'valid' : 'none',
  code: null,
  id: licensed ? ID : null,
  licensee: licensed ? 'Ada' : null,
  plan: licensed ? 'pro' : null,
  trial: { state: 'running', endsAt: Date.now() + 86_400_000, code: null, source: 'purchase' },
  activation: licensed ? { state: 'active', used: 1, limit: 3, expiresAt: null } : null,
  appStore: appStore && { ...appStore, code: null, takesKeys: true },
})

let host: HTMLDivElement
let root: Root
let answer: () => Promise<unknown>

beforeEach(() => {
  answer = async () => 'requested'
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === 'store_refund' ? answer() : undefined,
  )
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.mocked(invoke).mockReset()
})

async function settings(appStore: { pro: boolean } | null, licensed = false) {
  vi.mocked(invoke).mockResolvedValueOnce(snapshot(appStore, licensed))
  await readCurrentLicence()
  act(() => root.render(<PhoneSettings onOpenPane={() => {}} />))
}

const refundRow = () =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Request a Refund'))

const refundCalls = () =>
  vi.mocked(invoke).mock.calls.filter(([command]) => command === 'store_refund')

async function tap() {
  await act(async () => refundRow()?.click())
}

describe('Request a Refund', () => {
  it('shows only while an App Store build holds Devot Pro through the App Store', async () => {
    await settings(null, true)
    expect(refundRow()).toBeUndefined()
    act(() => root.render(<></>))
    await settings({ pro: false }, true)
    expect(refundRow()).toBeUndefined()
    act(() => root.render(<></>))
    await settings({ pro: false })
    expect(refundRow()).toBeUndefined()
    act(() => root.render(<></>))
    await settings({ pro: true })
    expect(refundRow()).toBeDefined()
  })

  it('asks Rust with nothing of its own and says the request was made', async () => {
    await settings({ pro: true })
    await tap()
    expect(refundCalls()).toEqual([['store_refund']])
    expect(refundRow()?.textContent).toContain('Requested')
  })

  it('is silent when the sheet is cancelled', async () => {
    answer = async () => 'cancelled'
    await settings({ pro: true })
    await tap()
    expect(refundRow()?.textContent).toBe('Request a Refund')
  })

  it('opens one sheet at a time', async () => {
    let done: (outcome: string) => void = () => {}
    answer = () => new Promise((resolve) => (done = resolve))
    await settings({ pro: true })
    await tap()
    expect(refundRow()?.textContent).toContain('Opening')
    await tap()
    expect(refundCalls()).toHaveLength(1)
    await act(async () => done('requested'))
    expect(refundRow()?.textContent).toContain('Requested')
  })

  it.each([
    ['E_APP_STORE_REFUND_DUPLICATE', 'Already requested'],
    ['E_APP_STORE_NETWORK', 'No connection'],
    ['E_APP_STORE_REFUND_FAILED', 'Could not open'],
    ['E_APP_STORE_NO_PRO', 'Could not open'],
  ])('says %s in a plain sentence, never the code', async (code, sentence) => {
    answer = async () => {
      throw code
    }
    await settings({ pro: true })
    await tap()
    expect(refundRow()?.textContent).toContain(sentence)
    expect(document.body.textContent).not.toMatch(/[EWI]_[A-Z0-9_]+/)
  })
})
