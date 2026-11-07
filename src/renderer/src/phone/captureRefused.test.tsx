// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '../ipc'
import { readCurrentLicence, useLicence } from '../licence'
import { closePurchase } from '../purchaseSheet'
import { PhoneCapture } from './PhoneCapture'
import { PhoneGate } from './PhoneProSheet'
import { closeGate } from './requireEditing'
import type { PhoneStore } from './usePhoneData'

vi.mock('../ipc', () => ({ invoke: vi.fn<() => Promise<unknown>>() }))
vi.stubGlobal('DEVOT_UI_TEST', true)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const RUNNING = {
  gated: true,
  state: 'none',
  code: null,
  id: null,
  licensee: null,
  plan: null,
  trial: { state: 'running', endsAt: Date.now() + 86_400_000, code: null, source: 'keychain' },
  activation: null,
  appStore: null,
}
const ENDED = { ...RUNNING, trial: { ...RUNNING.trial, state: 'ended', endsAt: Date.now() - 1 } }

let host: HTMLDivElement
let root: Root
let current: unknown
let captures: string[]
let saved: string[]

const store = (): PhoneStore =>
  ({
    core: {
      capture: async (title: string) => {
        captures.push(title)
        throw new Error('E_LICENCE_REQUIRED')
      },
      setStatus: async () => {},
    },
    notes: [],
    templates: [],
    books: [],
    tags: [],
    savedSearches: [],
    trash: [],
    lastBackup: null,
    loadedAt: 0,
    refresh: () => {},
    onTakenIn: () => () => {},
  }) as unknown as PhoneStore

function Screen() {
  const licence = useLicence()
  return (
    <>
      <PhoneCapture store={store()} available bookId={null} onSaved={(id) => saved.push(id)} />
      <PhoneGate licence={licence} onOpenLicence={() => {}} />
    </>
  )
}

beforeEach(() => {
  captures = []
  saved = []
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === 'licence_get' ? current : undefined,
  )
  host = document.createElement('div')
  host.className = 'phone-app'
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => {
    closeGate()
    closePurchase()
    root.unmount()
  })
  host.remove()
  document.body.innerHTML = ''
  vi.mocked(invoke).mockReset()
  vi.restoreAllMocks()
})

const capture = () => host.querySelector('.phone-capture')
const dialogNames = () =>
  [...document.querySelectorAll('[role="dialog"]')].map((d) => d.getAttribute('aria-label'))

describe('a new note refused on a stale licence', () => {
  it('closes the capture sheet, shows the lock, and creates nothing after an unlock', async () => {
    current = RUNNING
    await readCurrentLicence()
    await act(async () => root.render(<Screen />))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await act(async () => host.querySelector<HTMLElement>('.phone-capture-fab')?.click())
    expect(capture()?.hasAttribute('data-open')).toBe(true)
    const field = host.querySelector<HTMLInputElement>('.phone-capture-field input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        field,
        'Plans',
      )
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    current = ENDED
    await act(async () =>
      host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true })),
    )
    await vi.waitFor(() => expect(dialogNames()).toEqual(['Your trial has ended']))
    expect(capture()?.hasAttribute('data-open')).toBe(false)
    expect(captures).toEqual(['Plans'])
    expect(saved).toEqual([])
    expect(document.body.textContent).not.toMatch(/\b[EWI]_[A-Z0-9_]+/)

    current = RUNNING
    await act(async () => void (await readCurrentLicence()))
    expect(captures).toEqual(['Plans'])
    expect(saved).toEqual([])
    expect(capture()?.hasAttribute('data-open')).toBe(false)
  })
})
