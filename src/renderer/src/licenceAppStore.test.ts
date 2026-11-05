import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from './ipc'
import {
  APP_DEVICES_URL,
  BUY_URL,
  DEVICES_URL,
  editingAllowed,
  openBuy,
  openDevices,
  purchase,
  readCurrentLicence,
  readLicence,
  restorePurchases,
  soldOnAppStore,
  storeProducts,
  trialOver,
} from './licence'
import { closePurchase, purchaseOpen } from './purchaseSheet'

vi.mock('./ipc', () => ({ invoke: vi.fn<() => Promise<unknown>>() }))

const NOW = 1_790_000_000_000

const appStore = (patch: Record<string, unknown> = {}, trial: Record<string, unknown> = {}) => ({
  gated: true,
  state: 'none',
  code: null,
  id: null,
  licensee: null,
  plan: null,
  trial: { state: 'available', endsAt: null, code: null, source: 'purchase', ...trial },
  activation: null,
  appStore: { pro: false, code: null, takesKeys: true, ...patch },
})

const direct = {
  gated: true,
  state: 'none',
  code: null,
  id: null,
  licensee: null,
  plan: null,
  trial: { state: 'ended', endsAt: NOW - 1, code: null, source: 'keychain' },
  activation: null,
}

const show = async (value: unknown) => {
  vi.mocked(invoke).mockResolvedValue(value)
  await readCurrentLicence()
  vi.mocked(invoke).mockClear()
  vi.mocked(invoke).mockResolvedValue(undefined)
}

describe('an App Store build in a window', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
    closePurchase()
  })

  it('reads the purchases and the trial source Rust reports', () => {
    const licence = readLicence(appStore({ pro: true, code: 'E_APP_STORE_NO_REPLY' }))!
    expect(licence.appStore).toEqual({ pro: true, code: 'E_APP_STORE_NO_REPLY', takesKeys: true })
    expect(licence.trial).toEqual({
      state: 'available',
      endsAt: null,
      code: null,
      source: 'purchase',
    })
    expect(soldOnAppStore(licence)).toBe(true)
  })

  it('reads a build without purchases as sold elsewhere, its trial in the keychain', () => {
    const licence = readLicence({ ...direct, trial: { state: 'running', endsAt: NOW } })!
    expect(licence.appStore).toBeNull()
    expect(licence.trial?.source).toBe('keychain')
    expect(soldOnAppStore(licence)).toBe(false)
  })

  it('never reads a code that is not one', () => {
    expect(readLicence(appStore({ code: 'note text' }))!.appStore?.code).toBeNull()
  })

  it('unlocks editing with Devot Pro alone, and the trial is not over then', async () => {
    await show(appStore({ pro: true }, { state: 'ended' }))
    expect(editingAllowed()).toBe(true)
    expect(trialOver(readLicence(appStore({ pro: true }, { state: 'ended' }))!, NOW)).toBe(false)
  })

  it('keeps notes read-only without a purchase, a running trial or a licence', async () => {
    for (const trial of ['available', 'ended'])
      for (const code of [null, 'E_APP_STORE_UNREAD']) {
        await show(appStore({ code }, { state: trial }))
        expect(editingAllowed()).toBe(false)
      }
    await show(appStore({}, { state: 'running', endsAt: Date.now() + 60_000 }))
    expect(editingAllowed()).toBe(true)
  })

  it('opens the purchase sheet for Buy, never the licence site', async () => {
    await show(appStore())
    openBuy()
    expect(purchaseOpen()).toBe(true)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('opens the devices page made for the app', async () => {
    await show(appStore())
    openDevices()
    expect(invoke).toHaveBeenCalledWith('open_external', { url: APP_DEVICES_URL })
    expect(APP_DEVICES_URL).toBe(`${DEVICES_URL}?from=app`)
  })

  it('leaves a build sold elsewhere as it was', async () => {
    await show(direct)
    openBuy()
    expect(purchaseOpen()).toBe(false)
    expect(invoke).toHaveBeenCalledWith('open_external', { url: BUY_URL })
    openDevices()
    expect(invoke).toHaveBeenCalledWith('open_external', { url: DEVICES_URL })
  })
})

describe('the store commands', () => {
  beforeEach(() => vi.mocked(invoke).mockReset())

  it('take StoreKit prices only, and drop what they cannot read', async () => {
    vi.mocked(invoke).mockResolvedValue([
      { product: 'pro', displayName: 'Devot Pro', displayPrice: '$29.99' },
      { product: 'trial', displayName: 'Trial', displayPrice: 'Free' },
      { product: 'other', displayName: 'x', displayPrice: '$1' },
      { product: 'pro', displayName: 'Devot Pro' },
      null,
    ])
    expect(await storeProducts()).toEqual([
      { product: 'pro', displayName: 'Devot Pro', displayPrice: '$29.99' },
      { product: 'trial', displayName: 'Trial', displayPrice: 'Free' },
    ])
    expect(invoke).toHaveBeenCalledWith('store_products')
  })

  it('buy a product by its name, and read anything else as cancelled', async () => {
    vi.mocked(invoke).mockResolvedValue('pending')
    expect(await purchase('pro')).toBe('pending')
    expect(invoke).toHaveBeenCalledWith('store_purchase', { product: 'pro' })
    vi.mocked(invoke).mockResolvedValue('refunded')
    expect(await purchase('trial')).toBe('cancelled')
  })

  it('restore purchases and show the licence that follows', async () => {
    vi.mocked(invoke).mockResolvedValue(appStore({ pro: true }))
    const after = await restorePurchases()
    expect(invoke).toHaveBeenCalledWith('store_restore')
    expect(after.appStore?.pro).toBe(true)
    expect(editingAllowed()).toBe(true)
  })
})
