// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { PRICE } from '../../../../tests/support/price'
import { invoke } from '../ipc'
import { readCurrentLicence, type StoreProductView } from '../licence'
import { LicenceButton } from '../LicenceLocked'
import { LicenceSection } from '../settings/LicenceSection'
import { OnPhone } from '../settings/onPhone'
import { PhoneSettings } from './PhoneSettings'
import { PurchaseOffer } from './PhonePurchase'

vi.mock('../ipc', () => ({ invoke: vi.fn<() => Promise<unknown>>() }))
vi.stubGlobal('DEVOT_UI_TEST', true)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

/** What a surface shows: its markup, for links, and its text, for prices. */
function rendered(node: ReactNode): string {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(node))
  const html = host.innerHTML
  act(() => root.unmount())
  host.remove()
  return html
}

const shown = (markup: string) => {
  const holder = document.createElement('div')
  holder.innerHTML = markup
  return holder.textContent ?? ''
}

/** StoreKit's price for the storefront, which only the purchase sheet shows. */
const STOREKIT_PRICE = '31,99 €'

const appStore = (trial: 'available' | 'ended' | 'running', pro = false) => ({
  gated: true,
  state: 'none',
  code: null,
  id: null,
  licensee: null,
  plan: null,
  trial: {
    state: trial,
    endsAt: trial === 'available' ? null : Date.now() + (trial === 'running' ? 86_400_000 : -1),
    code: null,
    source: 'purchase',
  },
  activation: { state: 'active', used: 1, limit: 3, expiresAt: null },
  appStore: { pro, code: null, takesKeys: true },
})

const products: StoreProductView[] = [
  { product: 'pro', displayName: 'Devot Pro', displayPrice: STOREKIT_PRICE },
  { product: 'trial', displayName: 'Trial', displayPrice: '0,00 €' },
]

const noOutsidePurchase = (markup: string) => {
  expect(markup).not.toMatch(/\/buy\b/)
  expect(markup).not.toMatch(/devot\.online/)
  expect(shown(markup).replaceAll(STOREKIT_PRICE, '')).not.toMatch(PRICE)
}

describe('an App Store build on the phone', () => {
  beforeAll(() => {
    vi.mocked(invoke).mockResolvedValue(undefined)
  })

  for (const trial of ['available', 'ended', 'running'] as const)
    for (const pro of [false, true])
      it(`shows no outside purchase or price with the trial ${trial}${pro ? ' and Devot Pro' : ''}`, async () => {
        vi.mocked(invoke).mockResolvedValueOnce(appStore(trial, pro))
        const licence = await readCurrentLicence()
        noOutsidePurchase(rendered(<PhoneSettings onOpenPane={() => {}} />))
        noOutsidePurchase(
          rendered(
            <OnPhone.Provider value={true}>
              <LicenceSection />
            </OnPhone.Provider>,
          ),
        )
        noOutsidePurchase(rendered(<LicenceButton />))
        const sheet = rendered(
          <PurchaseOffer
            licence={licence}
            products={products}
            busy={null}
            message={null}
            onBuy={() => {}}
            onRestore={() => {}}
            onEnterKey={() => {}}
          />,
        )
        noOutsidePurchase(sheet)
        expect(sheet).toContain(STOREKIT_PRICE)
      })
})

describe('the purchase sheet', () => {
  const offer = async (
    trial: 'available' | 'ended',
    patch: Partial<Parameters<typeof PurchaseOffer>[0]> = {},
    takesKeys = true,
  ) => {
    const value = appStore(trial)
    vi.mocked(invoke).mockResolvedValueOnce({
      ...value,
      appStore: { ...value.appStore, takesKeys },
    })
    const licence = await readCurrentLicence()
    return rendered(
      <PurchaseOffer
        licence={licence}
        products={products}
        busy={null}
        message={null}
        onBuy={() => {}}
        onRestore={() => {}}
        onEnterKey={() => {}}
        {...patch}
      />,
    )
  }

  it('offers the trial with its length before it starts, and all four actions', async () => {
    const sheet = await offer('available')
    expect(sheet).toContain('Try Devot free for 30 days')
    expect(sheet).toContain('editing, sync and AI need Devot Pro')
    for (const label of [
      'Start 30-day Trial',
      'Buy Devot Pro',
      'Restore Purchases',
      'Enter License Key',
    ])
      expect(sheet).toContain(`>${label}`)
  })

  it('leaves the trial out once it has ended', async () => {
    const sheet = await offer('ended')
    expect(sheet).toContain('Your trial has ended')
    expect(sheet).not.toContain('Start 30-day Trial')
    expect(sheet).toContain('Buy Devot Pro')
  })

  it('does not say the trial has ended while the purchases are unknown', async () => {
    const value = appStore('ended')
    vi.mocked(invoke).mockResolvedValueOnce({
      ...value,
      appStore: { ...value.appStore, code: 'E_APP_STORE_NO_REPLY' },
    })
    const licence = await readCurrentLicence()
    const sheet = rendered(
      <PurchaseOffer
        licence={licence}
        products={products}
        busy={null}
        message={null}
        onBuy={() => {}}
        onRestore={() => {}}
        onEnterKey={() => {}}
      />,
    )
    expect(sheet).not.toContain('Your trial has ended')
    expect(sheet).toContain('Get Devot Pro')
    expect(sheet).toContain('Buy Devot Pro')
  })

  it('leaves Enter License Key out of a build that takes no key', async () => {
    expect(await offer('available', {}, false)).not.toContain('Enter License Key')
  })

  it('buys with no price before StoreKit gives one', async () => {
    const sheet = await offer('ended', { products: [] })
    expect(sheet).toContain('Buy Devot Pro')
    expect(shown(sheet)).not.toMatch(PRICE)
  })

  it('holds every action while one runs, and says why one failed', async () => {
    const sheet = await offer('ended', {
      busy: 'pro',
      message: { kind: 'failed', code: 'E_APP_STORE_NO_REPLY' },
    })
    expect(sheet.match(/aria-disabled="true"/g)).toHaveLength(2)
    expect(sheet).toContain('role="alert"')
    expect(sheet).toContain('The App Store did not reply.')
  })

  it('tells of a purchase waiting for approval', async () => {
    const sheet = await offer('ended', { message: { kind: 'pending' } })
    expect(sheet).toContain('role="status"')
    expect(sheet).toContain('Waiting for approval')
  })
})

describe('Settings in an App Store build', () => {
  it('has Restore Purchases, and shows Pro for a Devot Pro purchase', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(appStore('ended', true))
    await readCurrentLicence()
    const settings = rendered(<PhoneSettings onOpenPane={() => {}} />)
    expect(settings).toContain('>Restore Purchases<')
    expect(settings).toContain('>Pro<')
  })

  it('hides the key field in a build that takes no key, and offers Devot Pro for a lock', async () => {
    const value = appStore('ended')
    vi.mocked(invoke).mockResolvedValueOnce({
      ...value,
      appStore: { ...value.appStore, takesKeys: false },
    })
    await readCurrentLicence()
    const pane = rendered(
      <OnPhone.Provider value={true}>
        <LicenceSection />
      </OnPhone.Provider>,
    )
    expect(pane).not.toContain('License Key')
    expect(pane).toContain('Buy Devot Pro')
  })

  it('says why Restore Purchases failed in a sentence', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(appStore('ended'))
    await readCurrentLicence()
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'store_restore') throw new Error('E_APP_STORE_NO_REPLY')
      return undefined
    })
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    act(() => root.render(<PhoneSettings onOpenPane={() => {}} />))
    const restore = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Restore Purchases'),
    )
    await act(async () => restore?.click())
    expect(host.textContent).toContain('The App Store did not reply.')
    act(() => root.unmount())
    host.remove()
    vi.mocked(invoke).mockReset()
    vi.mocked(invoke).mockResolvedValue(undefined)
  })

  it('leaves a build sold elsewhere without Restore Purchases', async () => {
    const { appStore: _, ...direct } = appStore('ended')
    vi.mocked(invoke).mockResolvedValueOnce({
      ...direct,
      trial: { ...direct.trial, source: 'keychain' },
    })
    await readCurrentLicence()
    const settings = rendered(<PhoneSettings onOpenPane={() => {}} />)
    expect(settings).not.toContain('Restore Purchases')
    expect(rendered(<LicenceButton />)).toContain('Buy a License')
  })
})
