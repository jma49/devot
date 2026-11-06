// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { PRICE } from '../../../../tests/support/price'
import { invoke } from '../ipc'
import { readCurrentLicence, type StoreProductView } from '../licence'
import { LicenceButton } from '../LicenceLocked'
import { openPurchase, purchaseOpen } from '../purchaseSheet'
import { LicenceSection } from '../settings/LicenceSection'
import { OnPhone } from '../settings/onPhone'
import { PhoneSettings } from './PhoneSettings'
import { PhonePurchaseSheet, PurchaseOffer } from './PhonePurchase'

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
    const holder = document.createElement('div')
    holder.innerHTML = rendered(
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
    return holder
  }
  const primary = (sheet: HTMLElement) =>
    [...sheet.querySelectorAll('.phone-purchase-primary')].map((button) => button.textContent)
  const quiet = (sheet: HTMLElement) =>
    [...sheet.querySelectorAll('.phone-purchase-buy-once')].map((button) => button.textContent)
  const links = (sheet: HTMLElement) =>
    [...sheet.querySelectorAll('.phone-purchase-links button')].map((button) => button.textContent)

  it('says what Devot Pro unlocks and that reading stays free', async () => {
    const lines = [...(await offer('available')).querySelectorAll('li')].map((line) =>
      line.textContent?.trim(),
    )
    expect(lines).toEqual([
      'Write and edit every noteFree: read, search and export forever',
      'Sync with your Mac',
      'AI that suggests and edits',
    ])
  })

  it('leads with the trial, and buys once at the price in a quiet button', async () => {
    const sheet = await offer('available')
    expect(primary(sheet)).toEqual(['Try Free for 30 Days'])
    expect(quiet(sheet)).toEqual([`Buy Once for ${STOREKIT_PRICE}`])
    expect(links(sheet)).toEqual(['Restore Purchases', 'Enter License Key'])
    expect(sheet.querySelectorAll('.phone-purchase-divider')).toHaveLength(1)
  })

  it('makes buying the one action once the trial has ended', async () => {
    const sheet = await offer('ended')
    expect(primary(sheet)).toEqual([`Buy Devot Pro${STOREKIT_PRICE}`])
    expect(quiet(sheet)).toEqual([])
    expect(shown(sheet.innerHTML)).not.toContain('Try Free')
    expect(shown(sheet.innerHTML)).toContain('Free: read, search and export forever')
    expect(links(sheet)).toEqual(['Restore Purchases', 'Enter License Key'])
  })

  it('leaves Enter License Key and its divider out of a build that takes no key', async () => {
    for (const trial of ['available', 'ended'] as const) {
      const sheet = await offer(trial, {}, false)
      expect(links(sheet)).toEqual(['Restore Purchases'])
      expect(sheet.querySelector('.phone-purchase-divider')).toBeNull()
    }
  })

  it('buys with no price before StoreKit gives one', async () => {
    const before = await offer('available', { products: [] })
    expect(quiet(before)).toEqual(['Buy Devot Pro'])
    expect(shown(before.innerHTML)).not.toMatch(PRICE)
    const after = await offer('ended', { products: [] })
    expect(primary(after)).toEqual(['Buy Devot Pro'])
    expect(shown(after.innerHTML)).not.toMatch(PRICE)
  })

  it('holds every purchase action while one runs, and says why one failed', async () => {
    const sheet = await offer('available', {
      busy: 'pro',
      message: { kind: 'failed', code: 'E_APP_STORE_NO_REPLY' },
    })
    const held = [...sheet.querySelectorAll('[aria-disabled="true"]')].map((b) => b.textContent)
    expect(held).toEqual([
      'Try Free for 30 Days',
      `Buy Once for ${STOREKIT_PRICE}`,
      'Restore Purchases',
    ])
    expect(sheet.querySelector('[role="alert"]')?.textContent).toContain(
      'The purchase did not go through.',
    )
    expect(
      (await offer('ended', { busy: 'restore' })).querySelectorAll('[aria-disabled="true"]'),
    ).toHaveLength(2)
  })

  it('tells of a purchase waiting for approval', async () => {
    const sheet = await offer('ended', { message: { kind: 'pending' } })
    expect(sheet.querySelector('[role="status"]')?.textContent).toContain('Waiting for approval')
  })

  it('buys the trial or Devot Pro from their buttons, and restores from its link', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(appStore('available'))
    const licence = await readCurrentLicence()
    const asked: string[] = []
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    act(() =>
      root.render(
        <PurchaseOffer
          licence={licence}
          products={products}
          busy={null}
          message={null}
          onBuy={(product) => asked.push(product)}
          onRestore={() => asked.push('restore')}
          onEnterKey={() => asked.push('key')}
        />,
      ),
    )
    for (const button of host.querySelectorAll('button')) button.click()
    act(() => root.unmount())
    host.remove()
    expect(asked).toEqual(['trial', 'pro', 'restore', 'key'])
  })
})

describe('the purchase sheet over the app', () => {
  const open = async (licence: unknown) => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'store_products') return products
      if (command === 'licence_get') return licence
      return undefined
    })
    const current = await readCurrentLicence()
    openPurchase()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () =>
      root.render(<PhonePurchaseSheet licence={current} onEnterKey={() => {}} />),
    )
    return {
      dialog: document.querySelector<HTMLElement>('[role="dialog"]'),
      done: () => {
        act(() => root.unmount())
        host.remove()
        vi.mocked(invoke).mockReset()
        vi.mocked(invoke).mockResolvedValue(undefined)
      },
    }
  }

  const heading = (dialog: HTMLElement | null) => ({
    label: dialog?.getAttribute('aria-label'),
    title: dialog?.querySelector('h2')?.textContent,
  })

  it('heads the sheet with the dove and the state of the trial', async () => {
    const unknown = appStore('ended')
    for (const [licence, title] of [
      [appStore('available'), 'Devot Pro'],
      [appStore('ended'), 'Your trial has ended'],
      [appStore('running'), 'Devot Pro'],
      [
        {
          ...unknown,
          appStore: { ...unknown.appStore, code: 'E_APP_STORE_NO_REPLY' },
        },
        'Get Devot Pro',
      ],
    ] as const) {
      const { dialog, done } = await open(licence)
      expect(heading(dialog)).toEqual({ label: title, title })
      expect(dialog?.querySelector('.phone-sheet-head .phone-purchase-dove')).not.toBeNull()
      done()
    }
  })

  it('closes from the X in its head, and has no Not Now', async () => {
    const { dialog, done } = await open(appStore('available'))
    expect(dialog?.textContent).not.toContain('Not Now')
    const close = dialog?.querySelector<HTMLButtonElement>('.phone-sheet-head button')
    expect(close?.getAttribute('aria-label')).toBe('Close')
    act(() => close?.click())
    await vi.waitFor(() => expect(purchaseOpen()).toBe(false))
    done()
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
    expect(host.textContent).toContain('The App Store did not reply. (E_APP_STORE_NO_REPLY)')
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
