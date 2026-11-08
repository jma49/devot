// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '../ipc'
import { readCurrentLicence, useLicence } from '../licence'
import { closePurchase } from '../purchaseSheet'
import { PhoneGate } from './PhoneProSheet'
import { closeGate, requireEditing, watchWrite, type WriteIntent } from './requireEditing'

vi.mock('../ipc', () => ({ invoke: vi.fn<() => Promise<unknown>>() }))
vi.stubGlobal('DEVOT_UI_TEST', true)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const DAY = 86_400_000
const ID = '5vEvzHainWD0cA2Ht_ljHg'
const STOREKIT_PRICE = '31,99 €'

const trial = (state: 'running' | 'ended' | 'available', source = 'keychain') => ({
  state,
  endsAt: state === 'available' ? null : Date.now() + (state === 'running' ? DAY : -1),
  code: null,
  source,
})
const base = {
  gated: true,
  state: 'none',
  code: null,
  id: null,
  licensee: null,
  plan: null,
  activation: null,
  appStore: null,
}
const appStore = (code: string | null = null, pro = false) => ({ pro, code, takesKeys: true })

const LOCKED = {
  A1: { ...base, trial: trial('available', 'purchase'), appStore: appStore() },
  A2: { ...base, trial: trial('ended', 'purchase'), appStore: appStore() },
  A3: { ...base, trial: trial('ended', 'purchase'), appStore: appStore('E_APP_STORE_UNREAD') },
  K1: { ...base, trial: trial('ended') },
  K2: { ...base, state: 'revoked', id: ID, trial: trial('ended') },
  K2seat: {
    ...base,
    state: 'valid',
    id: ID,
    licensee: 'Ada',
    plan: 'pro',
    activation: { state: 'required', used: 3, limit: 3, expiresAt: null },
    trial: trial('ended'),
  },
  X1: { ...base, code: 'E_LICENCE_KEYCHAIN', trial: trial('ended') },
}
const RUNNING = { ...base, trial: trial('running') }
const APP_STORE_RUNNING = { ...base, trial: trial('running', 'purchase'), appStore: appStore() }

let host: HTMLDivElement
let root: Root
let current: unknown
let answers: Record<string, () => unknown>
let openedLicence: boolean[]

function Gate() {
  const licence = useLicence()
  return <PhoneGate licence={licence} onOpenLicence={(focusKey) => openedLicence.push(focusKey)} />
}

beforeEach(() => {
  answers = {}
  openedLicence = []
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === 'licence_get')
      return answers['licence_get'] ? answers['licence_get']() : current
    if (command === 'store_products')
      return [{ product: 'pro', displayName: 'Devot Pro', displayPrice: STOREKIT_PRICE }]
    return answers[command]?.()
  })
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

async function lockedAs(licence: unknown) {
  current = licence
  await readCurrentLicence()
  await act(async () => root.render(<Gate />))
}

/** What the user asked for, and how many times it ran. */
function asked(op: WriteIntent['op'] = 'newNote') {
  const runs = { count: 0 }
  const intent: WriteIntent = { op, id: null }
  return {
    runs,
    tap: async () => {
      await act(async () => requireEditing(intent, () => void (runs.count += 1)))
    },
  }
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const dialogs = () => document.querySelectorAll('[role="dialog"]').length
const nameOf = (b: Element) => b.textContent || b.getAttribute('aria-label')
const buttons = () => [...(dialog()?.querySelectorAll('button') ?? [])].map(nameOf)
const button = (name: string) =>
  [...(dialog()?.querySelectorAll('button') ?? [])].find((b) => nameOf(b) === name)
const press = async (name: string) => {
  await act(async () => button(name)?.click())
}
const line = () => dialog()?.querySelector('[role="status"]')?.textContent
const unlock = async (licence: unknown = RUNNING) => {
  current = licence
  await act(async () => void (await readCurrentLicence()))
}
const haptics = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === 'haptic')
    .map(([, args]) => args)

describe('a write while editing is locked', () => {
  const ROWS = [
    {
      row: 'A1',
      title: 'Devot Pro is not active',
      text: 'Free: read and search forever',
      buttons: [
        'Close',
        'Try Free for 30 Days',
        `Buy Once for ${STOREKIT_PRICE}`,
        'Restore Purchases',
        'Enter License Key',
      ],
    },
    {
      row: 'A2',
      title: 'Your trial has ended',
      text: 'Free: read and search forever',
      buttons: [
        'Close',
        `Buy Devot Pro${STOREKIT_PRICE}`,
        'Restore Purchases',
        'Enter License Key',
      ],
    },
    {
      row: 'A3',
      title: 'Get Devot Pro',
      text: 'Your App Store purchases could not be checked yet.',
      buttons: ['Try Again', 'Not Now', 'Restore Purchases'],
    },
    {
      row: 'K1',
      title: 'Your trial has ended',
      text: 'Notes stay readable and searchable. Editing needs a license.',
      buttons: ['Enter License Key', 'Not Now'],
    },
    {
      row: 'K2',
      title: 'License needs attention',
      text: "This device's license could not be verified.",
      buttons: ['Open License Settings', 'Not Now'],
    },
    {
      row: 'K2seat',
      title: 'License needs attention',
      text: "This iPhone is not on your license's device list.",
      buttons: ['Open License Settings', 'Not Now'],
    },
    {
      row: 'X1',
      title: 'License could not be read',
      text: 'Devot could not read its license from the keychain.',
      buttons: ['Try Again', 'Not Now'],
    },
  ] as const

  for (const row of ROWS)
    it(`shows ${row.row}'s sheet, with no code, and writes nothing`, async () => {
      await lockedAs(LOCKED[row.row])
      const write = asked()
      await write.tap()
      await vi.waitFor(() => expect(buttons()).toEqual(row.buttons))
      expect(dialog()?.getAttribute('aria-label')).toBe(row.title)
      expect(dialog()?.querySelector('h2')?.textContent).toBe(row.title)
      expect(dialog()?.textContent).toContain(row.text)
      expect(document.body.textContent).not.toMatch(/\b[EWI]_[A-Z0-9_]+/)
      expect(write.runs.count).toBe(0)
      expect(haptics()).toEqual([{ kind: 'warning' }])
    })

  it('names a price only in the purchase sheet, never in the short sheet', async () => {
    for (const row of ['A3', 'K1', 'K2', 'K2seat', 'X1'] as const) {
      await lockedAs(LOCKED[row])
      await asked().tap()
      await vi.waitFor(() => expect(dialog()).not.toBeNull())
      expect(dialog()?.textContent).not.toContain(STOREKIT_PRICE)
      expect(dialog()?.innerHTML).not.toMatch(/devot\.online|\/buy\b/)
      await press('Not Now')
      await vi.waitFor(() => expect(dialog()).toBeNull())
    }
  })

  it('says AI needs a license when AI asked for it', async () => {
    await lockedAs(LOCKED.K1)
    await asked('ai').tap()
    await vi.waitFor(() => expect(dialog()?.textContent).toContain('AI needs a license.'))
  })

  it('runs the write at once, with no sheet, while editing is allowed', async () => {
    await lockedAs(RUNNING)
    const write = asked()
    await write.tap()
    expect(write.runs.count).toBe(1)
    expect(dialog()).toBeNull()
    expect(haptics()).toEqual([])
  })

  it('opens one sheet for one tap, however often the tap comes', async () => {
    await lockedAs(LOCKED.K1)
    await asked().tap()
    await asked().tap()
    await vi.waitFor(() => expect(dialogs()).toBe(1))
    expect(haptics()).toHaveLength(1)
  })

  it('writes nothing after Not Now, even once editing is allowed', async () => {
    await lockedAs(LOCKED.K1)
    const write = asked()
    await write.tap()
    await press('Not Now')
    await vi.waitFor(() => expect(dialog()).toBeNull())
    await unlock()
    expect(write.runs.count).toBe(0)
  })

  it('writes nothing after the purchase sheet is closed', async () => {
    await lockedAs(LOCKED.A1)
    const write = asked()
    await write.tap()
    await press('Close')
    await vi.waitFor(() => expect(dialog()).toBeNull())
    await unlock(APP_STORE_RUNNING)
    expect(write.runs.count).toBe(0)
  })

  it('continues what was asked for once Try Free has started the trial', async () => {
    await lockedAs(LOCKED.A1)
    answers['store_purchase'] = () => {
      current = APP_STORE_RUNNING
      return 'purchased'
    }
    const write = asked()
    await write.tap()
    await vi.waitFor(() => expect(button('Try Free for 30 Days')).toBeDefined())
    await press('Try Free for 30 Days')
    await vi.waitFor(() => expect(write.runs.count).toBe(1))
    expect(dialog()).toBeNull()
  })

  it('asks again, writing nothing, when the purchase did not unlock editing', async () => {
    await lockedAs(LOCKED.A1)
    answers['store_purchase'] = () => 'purchased'
    const write = asked()
    await write.tap()
    await vi.waitFor(() => expect(button('Try Free for 30 Days')).toBeDefined())
    await press('Try Free for 30 Days')
    await vi.waitFor(() => expect(haptics()).toHaveLength(2))
    expect(write.runs.count).toBe(0)
    await vi.waitFor(() =>
      expect(dialog()?.getAttribute('aria-label')).toBe('Devot Pro is not active'),
    )
  })

  it('continues once a purchase waiting for approval is approved', async () => {
    await lockedAs(LOCKED.A2)
    const write = asked()
    await write.tap()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    await unlock({ ...LOCKED.A2, appStore: appStore(null, true) })
    expect(write.runs.count).toBe(1)
    expect(dialog()).toBeNull()
  })

  it('continues after Try Again reads the license, and stays when it is still locked', async () => {
    await lockedAs(LOCKED.X1)
    const write = asked()
    await write.tap()
    await vi.waitFor(() => expect(button('Try Again')).toBeDefined())
    let read: (licence: unknown) => void = () => {}
    answers['licence_get'] = () => new Promise((resolve) => (read = resolve))
    await press('Try Again')
    expect(line()).toBe('Checking…')
    delete answers['licence_get']
    await act(async () => read(current))
    await vi.waitFor(() =>
      expect(button('Try Again')?.getAttribute('aria-disabled')).not.toBe('true'),
    )
    expect(line()).toBe('Editing is still not available.')
    expect(write.runs.count).toBe(0)
    expect(dialog()?.textContent).toContain('Devot could not read its license from the keychain.')
    current = RUNNING
    await press('Try Again')
    await vi.waitFor(() => expect(write.runs.count).toBe(1))
    expect(dialog()).toBeNull()
  })

  it('writes nothing when Not Now comes before the Try Again check answers that writing is allowed', async () => {
    await lockedAs(LOCKED.X1)
    const write = asked()
    await write.tap()
    await vi.waitFor(() => expect(button('Try Again')).toBeDefined())
    let read: (licence: unknown) => void = () => {}
    answers['licence_get'] = () => new Promise((resolve) => (read = resolve))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await press('Try Again')
      await press('Not Now')
      delete answers['licence_get']
      current = RUNNING
      await act(async () => read(RUNNING))
      await act(async () => void vi.advanceTimersByTime(1000))
    } finally {
      vi.useRealTimers()
    }
    expect(write.runs.count).toBe(0)
    expect(dialog()).toBeNull()
  })

  it('says so under Try Again when the license could not be read', async () => {
    await lockedAs(LOCKED.X1)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const write = asked()
    await write.tap()
    await vi.waitFor(() => expect(button('Try Again')).toBeDefined())
    answers['licence_get'] = () => Promise.reject(new Error('E_LICENCE_KEYCHAIN'))
    await press('Try Again')
    await vi.waitFor(() =>
      expect(line()).toBe('The check did not go through. Try again in a moment.'),
    )
    expect(write.runs.count).toBe(0)
    expect(document.body.textContent).not.toMatch(/\b[EWI]_[A-Z0-9_]+/)
  })

  it('opens License with the key field for Enter License Key, and drops the write', async () => {
    await lockedAs(LOCKED.K1)
    const write = asked()
    await write.tap()
    await vi.waitFor(() => expect(button('Enter License Key')).toBeDefined())
    await press('Enter License Key')
    expect(openedLicence).toEqual([true])
    expect(dialog()).toBeNull()
    await unlock()
    expect(write.runs.count).toBe(0)
  })

  it('opens License for Open License Settings, and drops the write', async () => {
    await lockedAs(LOCKED.K2)
    const write = asked()
    await write.tap()
    await vi.waitFor(() => expect(button('Open License Settings')).toBeDefined())
    await press('Open License Settings')
    expect(openedLicence).toEqual([false])
    await unlock()
    expect(write.runs.count).toBe(0)
  })

  it("drops the write from the purchase sheet's Enter License Key", async () => {
    await lockedAs(LOCKED.A1)
    const write = asked()
    await write.tap()
    await vi.waitFor(() => expect(button('Enter License Key')).toBeDefined())
    await press('Enter License Key')
    expect(openedLicence).toEqual([true])
    await unlock(APP_STORE_RUNNING)
    expect(write.runs.count).toBe(0)
  })

  it('drops the write when the app goes to the background', async () => {
    await lockedAs(LOCKED.A2)
    const write = asked()
    await write.tap()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    visibility.mockRestore()
    await unlock({ ...LOCKED.A2, appStore: appStore(null, true) })
    expect(write.runs.count).toBe(0)
  })

  it('drops a write asked for more than ten minutes ago', async () => {
    await lockedAs(LOCKED.A2)
    const write = asked()
    const now = Date.now()
    await write.tap()
    vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60_000)
    await unlock({ ...LOCKED.A2, appStore: appStore(null, true) })
    expect(write.runs.count).toBe(0)
  })

  it('shows the sheet for a write refused on a stale state, logs only the code, and never runs it again', async () => {
    await lockedAs(RUNNING)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    current = LOCKED.K1
    const runs = { count: 0 }
    await act(async () =>
      requireEditing({ op: 'newNotebook', id: null }, () => {
        runs.count += 1
        watchWrite('newNotebook', Promise.reject(new Error('E_LICENCE_REQUIRED')))
      }),
    )
    await vi.waitFor(() =>
      expect(dialog()?.getAttribute('aria-label')).toBe('Your trial has ended'),
    )
    expect(warn).toHaveBeenCalledWith('W_PHONE_WRITE_LOCKED op=newNotebook code=E_LICENCE_REQUIRED')
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'licence_get')).toHaveLength(2)
    expect(document.body.textContent).not.toContain('E_LICENCE_REQUIRED')
    await unlock()
    expect(runs.count).toBe(1)
    expect(dialogs()).toBeLessThanOrEqual(1)
    expect(haptics()).toEqual([{ kind: 'warning' }])
  })

  it('closes the sheet for a refused write on its own once a licence change allows writing', async () => {
    await lockedAs(RUNNING)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    current = LOCKED.K1
    await act(async () =>
      watchWrite('newNotebook', Promise.reject(new Error('E_LICENCE_REQUIRED'))),
    )
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    await unlock()
    expect(dialog()).toBeNull()
  })

  it('logs any other failure of a write without a sheet', async () => {
    await lockedAs(RUNNING)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await act(async () => {
      watchWrite('trash', Promise.reject(new Error('E_NOTE_NOT_FOUND')), 'W_PHONE_TRASH_FAILED')
    })
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('W_PHONE_TRASH_FAILED', 'E_NOTE_NOT_FOUND'),
    )
    expect(dialog()).toBeNull()
  })
})
