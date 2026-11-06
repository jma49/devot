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
const KEY = 'devot1.eyJpZCI6IjV2RXZ6SGFpbldEMGNBMkh0X2xqSGcifQ.c2lnbmF0dXJl'

const snapshot = (appStore: { pro: boolean } | null) => ({
  gated: true,
  state: 'none',
  code: null,
  id: null,
  licensee: null,
  plan: null,
  trial: { state: 'ended', endsAt: 1, code: null, source: 'purchase' },
  activation: null,
  appStore: appStore && { ...appStore, code: null, takesKeys: true },
})

let host: HTMLDivElement
let root: Root
let answer: () => Promise<unknown>

beforeEach(() => {
  answer = async () => ({ key: KEY, id: ID })
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === 'store_mac_key' ? answer() : undefined,
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
  vi.unstubAllGlobals()
  vi.stubGlobal('DEVOT_UI_TEST', true)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})

async function settings(appStore: { pro: boolean } | null) {
  vi.mocked(invoke).mockResolvedValueOnce(snapshot(appStore))
  await readCurrentLicence()
  act(() => root.render(<PhoneSettings onOpenPane={() => {}} />))
}

const button = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(label))

const commands = () => vi.mocked(invoke).mock.calls.map(([command, args]) => [command, args])

async function openKey() {
  await act(async () => button('Get a Mac License Key')?.click())
}

describe('Get a Mac License Key', () => {
  it('shows only while the App Store build holds Devot Pro', async () => {
    await settings({ pro: false })
    expect(button('Get a Mac License Key')).toBeUndefined()
    act(() => root.render(<></>))
    await settings(null)
    expect(button('Get a Mac License Key')).toBeUndefined()
    act(() => root.render(<></>))
    await settings({ pro: true })
    expect(button('Get a Mac License Key')).toBeDefined()
  })

  it('asks Rust for the key with nothing of its own, shows it, and never adds it here', async () => {
    await settings({ pro: true })
    await openKey()
    expect(commands()).toContainEqual(['store_mac_key', undefined])
    expect(document.body.textContent).toContain(KEY)
    expect(document.body.textContent).toContain('Add it in Devot on your Mac')
    expect(commands().map(([command]) => command)).not.toContain('licence_set')
    expect(document.body.innerHTML).not.toMatch(/devot\.online|\/buy\b/)
  })

  it('copies the key', async () => {
    await settings({ pro: true })
    await openKey()
    await act(async () => button('Copy Key')?.click())
    expect(commands()).toContainEqual(['clipboard_write_text', { text: KEY }])
    expect(document.body.textContent).toContain('Copied')
  })

  it('shares the key with the link that opens it in Devot on a Mac, where sharing exists', async () => {
    await settings({ pro: true })
    await openKey()
    expect(button('Share')).toBeUndefined()
    act(() => root.render(<></>))

    const share = vi.fn<(data: ShareData) => Promise<void>>(async () => {})
    vi.stubGlobal('navigator', { ...navigator, share })
    await settings({ pro: true })
    await openKey()
    await act(async () => button('Share')?.click())
    const text = share.mock.calls[0]?.[0].text ?? ''
    expect(text).toContain(KEY)
    expect(text).toContain(`devot://licence?key=${encodeURIComponent(KEY)}`)
  })

  it('says why the Worker gave no key, and asks again on Try Again', async () => {
    answer = async () => {
      throw new Error('E_APP_STORE_FAMILY_SHARED')
    }
    await settings({ pro: true })
    await openKey()
    expect(document.body.textContent).toContain(
      'The key could not be fetched. A purchase shared through Family Sharing comes with no license key.',
    )
    answer = async () => ({ key: KEY, id: ID })
    await act(async () => button('Try Again')?.click())
    expect(commands().filter(([command]) => command === 'store_mac_key')).toHaveLength(2)
    expect(document.body.textContent).toContain(KEY)
  })

  it('takes nothing but a licence key and its ID from Rust', async () => {
    answer = async () => ({ key: 'not a key', id: ID })
    await settings({ pro: true })
    await openKey()
    expect(document.body.textContent).toContain('The license server could not give a key.')
    expect(document.body.textContent).not.toContain('not a key')
  })
})
