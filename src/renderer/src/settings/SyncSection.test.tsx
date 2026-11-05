// @vitest-environment happy-dom
// Settings > Sync on the Mac and the phone layouts, for each state Rust reports: the snapshot it
// sends and `sync_icloud_status`, answered here as the commands answer.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setIPhoneWording } from '../i18n'
import { enPhone } from '../i18n/phone'
import { OnPhone } from './onPhone'
import { SyncSection } from './SyncSection'
import { SYNC_CHANGED } from '../sync'
import type { ICloudStatus } from '../syncICloud'
import { settle } from '../../../../tests/support/render-hook'

vi.hoisted(() => vi.stubGlobal('DEVOT_UI_TEST', true))

interface Answers {
  snapshot: Record<string, unknown>
  icloud: ICloudStatus | Error
  devices: Record<string, unknown>[]
  useFails?: string | undefined
}

const DEVICES = [
  { id: 'mac', label: 'Studio', created: Date.UTC(2026, 10, 4), current: true },
  { id: 'phone', label: 'Pocket', created: Date.UTC(2026, 10, 3), current: false },
]

const answers: Answers = { snapshot: {}, icloud: new Error('E_COMMAND_FAILED'), devices: DEVICES }
const calls: { cmd: string; args: unknown }[] = []

vi.mock('../ipc', () => ({
  invoke: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(async (cmd, args) => {
    calls.push({ cmd, args })
    switch (cmd) {
      case 'licence_get':
        return { gated: false, state: 'none', code: null, id: null, licensee: null, plan: null }
      case 'sync_icloud_use':
        if (answers.useFails) throw new Error(answers.useFails)
        return answers.snapshot
      case 'sync_get':
      case 'sync_icloud_join':
      case 'sync_icloud_upload_again':
      case 'sync_set':
        return answers.snapshot
      case 'sync_icloud_leave':
        if ((args as { recoveryKey?: string }).recoveryKey !== 'THIS-VAULT')
          throw new Error('E_SYNC_RECOVERY_OTHER_VAULT')
        return answers.snapshot
      case 'sync_icloud_status':
        if (answers.icloud instanceof Error) throw answers.icloud
        return answers.icloud
      case 'sync_recovery_key':
        return null
      case 'sync_vault_rotate':
        if ((args as { relaySecret?: string }).relaySecret !== 'relay-secret')
          throw new Error('E_SYNC_RELAY_SECRET')
        return { snapshot: answers.snapshot, recoveryKey: 'ABCDE-FGHIJ-KLMNO' }
      case 'sync_devices':
        return answers.devices
      case 'sync_icloud_storage':
        return 2_500_000
      default:
        throw new Error('E_SYNC_OFFLINE')
    }
  }),
}))

const ICLOUD: ICloudStatus = { available: true, account: 'available' }
const NO_CONTAINER = new Error('E_COMMAND_FAILED')
const later = Date.now() + 3_600_000

function snapshot(over: {
  enabled?: boolean
  transport?: 'relay' | 'icloud'
  vault?: boolean
  enrolled?: boolean
  status?: Record<string, unknown>
  icloudJoin?: Record<string, unknown> | null
  moveStarted?: boolean
  rotated?: boolean
}) {
  const relay = over.transport === 'relay'
  return {
    relayUrl: relay && (over.vault ?? true) ? 'https://relay.example.test' : '',
    enabled: over.enabled ?? true,
    transport: over.transport ?? 'icloud',
    vault: over.vault ?? true,
    enrolled: over.enrolled ?? false,
    status: {
      state: 'idle',
      lastSync: Date.UTC(2026, 10, 5),
      code: null,
      tooLarge: 0,
      ...over.status,
    },
    icloudJoin: over.icloudJoin ?? null,
    moveStarted: over.moveStarted ?? false,
    rotated: over.rotated ?? false,
  }
}

let root: Root | undefined
let host: HTMLElement | undefined

afterEach(() => {
  if (root) act(() => root?.unmount())
  host?.remove()
  root = undefined
  setIPhoneWording(false)
  calls.length = 0
  answers.devices = DEVICES
  answers.useFails = undefined
  vi.restoreAllMocks()
})

async function show(
  shown: Record<string, unknown>,
  icloud: ICloudStatus | Error,
  phone: boolean,
): Promise<HTMLElement> {
  answers.snapshot = shown
  answers.icloud = icloud
  setIPhoneWording(phone)
  host = document.createElement('div')
  document.body.append(host)
  const r = createRoot(host)
  root = r
  act(() =>
    r.render(
      <OnPhone.Provider value={phone}>
        <SyncSection />
      </OnPhone.Provider>,
    ),
  )
  await settle()
  // The listener outlives a test: each shows its snapshot as Rust's change event would.
  act(() => window.dispatchEvent(new CustomEvent(SYNC_CHANGED, { detail: shown })))
  await settle()
  await settle()
  return host
}

const buttons = (el: HTMLElement) =>
  [...el.querySelectorAll('button')].map((b) => ({
    text: b.textContent?.trim() ?? '',
    disabled: b.disabled,
  }))
const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
const type = (input: HTMLInputElement, text: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })

describe.each([
  ['the Mac', false],
  ['the phone', true],
])('Settings > Sync on %s', (_, phone) => {
  it('asks iCloud or a relay first, and keeps the relay under the advanced choice', async () => {
    const el = await show(
      snapshot({ enabled: false, vault: false, transport: 'relay' }),
      ICLOUD,
      phone,
    )
    expect(button(el, 'Sync Through iCloud')?.disabled).toBe(false)
    expect(button(el, 'Use My Own Relay')).toBeDefined()
    expect(button(el, 'This Is My First Device')).toBeUndefined()
    expect(el.querySelector('input[type=url]')).toBeNull()
    await act(async () => button(el, 'Use My Own Relay')?.click())
    expect(button(el, 'This Is My First Device')).toBeDefined()
    expect(button(el, 'Use iCloud Instead')).toBeDefined()
  })

  it('turns iCloud on from the question', async () => {
    const el = await show(
      snapshot({ enabled: false, vault: false, transport: 'relay' }),
      ICLOUD,
      phone,
    )
    await act(async () => button(el, 'Sync Through iCloud')?.click())
    await settle()
    expect(calls.filter((c) => c.cmd === 'sync_icloud_use')).toEqual([
      { cmd: 'sync_icloud_use', args: {} },
    ])
  })

  it('offers only the relay in a build without the container', async () => {
    const el = await show(
      snapshot({ enabled: false, vault: false, transport: 'relay' }),
      NO_CONTAINER,
      phone,
    )
    expect(button(el, 'Sync Through iCloud')).toBeUndefined()
    expect(button(el, 'This Is My First Device')).toBeDefined()
  })

  it('keeps iCloud off and says why while the account is signed out or restricted', async () => {
    for (const [account, words] of [
      ['noAccount', /Sign in to iCloud/],
      ['restricted', /restricted/],
      ['temporarilyUnavailable', /not available right now|unavailable/],
    ] as const) {
      const el = await show(
        snapshot({ enabled: false, vault: false, transport: 'relay' }),
        { available: true, account },
        phone,
      )
      expect(button(el, 'Sync Through iCloud')?.disabled).toBe(true)
      expect(el.textContent).toMatch(words)
      act(() => root?.unmount())
      root = undefined
    }
  })

  it('asks once to join the Apple ID’s vault, with the count of notes here', async () => {
    const el = await show(
      snapshot({
        enabled: false,
        vault: false,
        transport: 'relay',
        icloudJoin: { state: 'ask', notes: 42 },
      }),
      ICLOUD,
      phone,
    )
    expect(el.textContent).toContain('42')
    expect(button(el, 'Not Now')).toBeDefined()
    await act(async () => button(el, 'Join')?.click())
    await settle()
    expect(calls.find((c) => c.cmd === 'sync_icloud_join')?.args).toEqual({ accept: true })
  })

  it('offers the pairing code and the recovery key when the handover item is missing', async () => {
    const el = await show(
      snapshot({
        enabled: false,
        vault: false,
        transport: 'relay',
        icloudJoin: { state: 'fallback', reason: 'missing' },
      }),
      ICLOUD,
      phone,
    )
    expect(el.textContent).toMatch(/code.* or (with )?the recovery key/)
    expect(el.textContent).toContain('Join With a Code')
    expect(el.textContent).toContain('Join With Recovery Key')
  })

  it('shows a vault on iCloud: transport, storage, devices without Remove, and the code as fallback', async () => {
    const el = await show(snapshot({}), ICLOUD, phone)
    expect(el.textContent).toContain('Syncs Through')
    expect(el.textContent).toMatch(/iCloud, (with your notes )?encrypted by Devot/)
    expect(el.textContent).toContain('Stored in iCloud')
    expect(el.textContent).toMatch(/About 2\.5\s?MB/)
    expect(el.textContent).toMatch(
      phone ? /Manage iCloud storage in Settings/ : /System Settings > Apple Account > iCloud/,
    )
    expect(el.textContent).toMatch(/day each was last seen/i)
    expect(el.textContent).not.toMatch(/leaves? by signing out/i)
    expect(el.textContent).toContain('Pocket')
    expect(el.textContent).toMatch(/Seen /)
    expect(buttons(el).some((b) => b.text.startsWith('Remove'))).toBe(false)
    expect(button(el, 'Show Pairing Code')).toBeDefined()
    expect(el.querySelector('input[type=url]')).toBeNull()
    expect(calls.some((c) => c.cmd === 'sync_usage')).toBe(false)
  })

  it('names the relay devices not seen on iCloud since the move, with the day each was added', async () => {
    answers.devices = [
      ...DEVICES,
      {
        id: 'pad',
        label: 'Slate',
        created: Date.UTC(2026, 8, 1, 12),
        current: false,
        unseen: true,
      },
    ]
    const el = await show(snapshot({}), ICLOUD, phone)
    const rows = [...el.querySelectorAll('.sync-device')].map((row) => row.textContent ?? '')
    expect(rows).toHaveLength(3)
    const pad = rows.find((row) => row.includes('Slate'))
    expect(pad).toMatch(/Added Sep 1, 2026/)
    expect(pad).toMatch(/Not on iCloud yet/)
    expect(pad).not.toMatch(/Seen /)
    expect(rows.find((row) => row.includes('Pocket'))).not.toMatch(/Not on iCloud yet/)
    expect(el.textContent).toMatch(/follow the move/)
    expect(buttons(el).some((b) => b.text.startsWith('Remove'))).toBe(false)
  })

  it('says nothing of the move once every device is on iCloud', async () => {
    const el = await show(snapshot({}), ICLOUD, phone)
    expect(el.textContent).not.toMatch(/Not on iCloud yet|follow the move/)
  })

  it.each([
    ['signed out', { state: 'paused', code: 'E_SYNC_ICLOUD_SIGNED_OUT' }, /Sign in to iCloud/, []],
    ['restricted', { state: 'paused', code: 'E_SYNC_ICLOUD_RESTRICTED' }, /restricted/, []],
    [
      'temporarily unavailable',
      { state: 'offline', code: 'E_SYNC_ICLOUD_ACCOUNT_UNAVAILABLE' },
      /unavailable|not available right now/,
      [],
    ],
    ['full', { state: 'paused', code: 'E_SYNC_ICLOUD_FULL' }, /iCloud (storage )?is full/, []],
    [
      'rate-limited',
      { state: 'paused', code: 'E_SYNC_ICLOUD_BUSY', pausedUntil: later },
      /wait/,
      [],
    ],
    [
      'account changed',
      { state: 'stopped', code: 'E_SYNC_ICLOUD_ACCOUNT_CHANGED' },
      /another Apple ID/,
      ['Move to This Apple ID…', 'Turn Sync Off'],
    ],
    [
      'zone gone',
      { state: 'stopped', code: 'E_SYNC_ICLOUD_DELETED' },
      /removed from iCloud/,
      ['Upload Again…', 'Turn Sync Off'],
    ],
    [
      'without the container',
      { state: 'stopped', code: 'E_SYNC_CLOUDKIT_UNAVAILABLE' },
      /cannot (sync through|use) iCloud/,
      ['Turn Sync Off'],
    ],
  ] as const)('words the vault %s, with what to do', async (_state, status, words, actions) => {
    const el = await show(snapshot({ status }), ICLOUD, phone)
    expect(el.textContent).toMatch(words)
    for (const action of actions) expect(button(el, action)?.disabled).toBe(false)
    expect(button(el, 'Turn Sync Off') !== undefined).toBe(
      (actions as readonly string[]).includes('Turn Sync Off'),
    )
  })

  it('words a failure the app can explain without its code, and logs the code', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const el = await show(
      snapshot({ enabled: false, vault: false, transport: 'relay' }),
      ICLOUD,
      phone,
    )
    answers.useFails = 'E_SYNC_CLOUDKIT_UNAVAILABLE'
    await act(async () => button(el, 'Sync Through iCloud')?.click())
    await settle()
    const alert = el.querySelector('[role=alert]')?.textContent ?? ''
    expect(alert).toMatch(/^Sync through iCloud could not be changed\. .*iCloud/)
    expect(el.textContent).not.toContain('E_SYNC_CLOUDKIT_UNAVAILABLE')
    expect(warn).toHaveBeenCalledWith('W_SYNC_SETTINGS_FAILED E_SYNC_CLOUDKIT_UNAVAILABLE')
  })

  it('keeps the code in a failure the app cannot explain', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const el = await show(
      snapshot({ enabled: false, vault: false, transport: 'relay' }),
      ICLOUD,
      phone,
    )
    answers.useFails = 'E_SYNC_UNEXPLAINED'
    await act(async () => button(el, 'Sync Through iCloud')?.click())
    await settle()
    expect(el.querySelector('[role=alert]')?.textContent).toContain('(E_SYNC_UNEXPLAINED)')
    expect(warn).not.toHaveBeenCalled()
  })

  it('shows the code on a state no words cover, and not on one they do', async () => {
    const plain = await show(
      snapshot({ transport: 'relay', status: { state: 'stopped', code: 'E_SYNC_UNEXPLAINED' } }),
      ICLOUD,
      phone,
    )
    expect(plain.textContent).toContain('Code E_SYNC_UNEXPLAINED.')
  })

  it('shows no code beside the words for a build without the container', async () => {
    const el = await show(
      snapshot({ status: { state: 'stopped', code: 'E_SYNC_CLOUDKIT_UNAVAILABLE' } }),
      ICLOUD,
      phone,
    )
    expect(el.textContent).not.toContain('E_SYNC_CLOUDKIT_UNAVAILABLE')
  })

  it('keeps the upload and the last sync on an iCloud state', async () => {
    const el = await show(
      snapshot({
        status: { state: 'paused', code: 'E_SYNC_ICLOUD_FULL', upload: { sent: 3, total: 10 } },
      }),
      ICLOUD,
      phone,
    )
    expect(el.textContent).toMatch(/iCloud (storage )?is full/)
    expect(el.textContent).toContain('3 of 10 items uploaded.')
    expect(el.textContent).not.toContain('E_SYNC_ICLOUD_FULL')
    expect(el.textContent).toMatch(/Last synced /)
  })

  it('tells, before moving to this Apple ID, how the other devices follow', async () => {
    const el = await show(
      snapshot({ status: { state: 'stopped', code: 'E_SYNC_ICLOUD_ACCOUNT_CHANGED' } }),
      ICLOUD,
      phone,
    )
    await act(async () => button(el, 'Move to This Apple ID…')?.click())
    expect(document.body.textContent).toContain(
      'by signing in to this Apple ID and moving there too',
    )
  })

  it('turns sync off from a stopped vault', async () => {
    const el = await show(
      snapshot({ status: { state: 'stopped', code: 'E_SYNC_ICLOUD_DELETED' } }),
      ICLOUD,
      phone,
    )
    await act(async () => button(el, 'Turn Sync Off')?.click())
    await settle()
    expect(calls.find((c) => c.cmd === 'sync_set')?.args).toEqual({ patch: { enabled: false } })
  })

  it('says the device joined through the iCloud Keychain', async () => {
    const el = await show(snapshot({ icloudJoin: { state: 'joined' } }), ICLOUD, phone)
    expect(el.textContent).toMatch(
      /Joined through iCloud Keychain|through the iCloud Keychain and joined/,
    )
  })

  it('offers to follow a vault that moved to iCloud', async () => {
    const el = await show(
      snapshot({
        transport: 'relay',
        enrolled: true,
        status: { state: 'stopped', code: 'E_SYNC_VAULT_MOVED' },
      }),
      ICLOUD,
      phone,
    )
    expect(el.textContent).toMatch(/moved to iCloud/)
    await act(async () => button(el, 'Follow to iCloud')?.click())
    await settle()
    expect(calls.find((c) => c.cmd === 'sync_icloud_use')?.args).toEqual({})
  })

  it('offers to finish a move to iCloud this device started', async () => {
    const el = await show(
      snapshot({
        transport: 'relay',
        enrolled: true,
        moveStarted: true,
        status: { state: 'stopped', code: 'E_SYNC_VAULT_MOVED' },
      }),
      ICLOUD,
      phone,
    )
    expect(el.textContent).toMatch(phone ? /Move to iCloud not finished/ : /started on this device/)
    expect(el.textContent).not.toMatch(/another of your devices/)
    expect(button(el, 'Follow to iCloud')).toBeUndefined()
    expect(button(el, 'Move to iCloud…')).toBeUndefined()
    await act(async () => button(el, 'Finish Moving to iCloud')?.click())
    await settle()
    expect(calls.find((c) => c.cmd === 'sync_icloud_use')?.args).toEqual({})
  })

  it('offers a relay vault the move to iCloud only where iCloud can take it', async () => {
    const relay = snapshot({ transport: 'relay', enrolled: true })
    const el = await show(relay, ICLOUD, phone)
    expect(button(el, 'Move to iCloud…')).toBeDefined()
    act(() => root?.unmount())
    root = undefined
    const without = await show(relay, NO_CONTAINER, phone)
    expect(button(without, 'Move to iCloud…')).toBeUndefined()
    expect(without.textContent).not.toContain('Syncs Through')
    expect(without.querySelector('input[type=url]')).not.toBeNull()
  })

  it('leaves an iCloud vault only once its recovery key is typed', async () => {
    const el = await show(snapshot({}), ICLOUD, phone)
    expect(el.textContent).toMatch(/notes stay/i)
    expect(el.querySelector('input[type=text]')).toBeNull()
    await act(async () => button(el, 'Leave This Vault…')?.click())
    const key = el.querySelector<HTMLInputElement>('input[type=text]')
    expect(key).not.toBeNull()
    const hint = key?.getAttribute('aria-describedby')
    expect(hint && document.getElementById(hint)?.textContent).toMatch(
      phone ? /^Removed from iCloud for every device$/ : /recovery key/,
    )
    expect(button(el, 'Leave This Vault')?.disabled).toBe(true)
    expect(calls.some((c) => c.cmd === 'sync_icloud_leave')).toBe(false)
    if (!key) return
    type(key, 'OTHER-VAULT')
    await act(async () => button(el, 'Leave This Vault')?.click())
    await settle()
    expect(el.textContent).toMatch(/recovery key of another vault/)
    type(key, 'THIS-VAULT')
    await act(async () => button(el, 'Leave This Vault')?.click())
    await settle()
    expect(calls.filter((c) => c.cmd === 'sync_icloud_leave').map((c) => c.args)).toEqual([
      { recoveryKey: 'OTHER-VAULT' },
      { recoveryKey: 'THIS-VAULT' },
    ])
    await act(() => new Promise((resolve) => setTimeout(resolve, 60)))
    expect(el.textContent).toMatch(/removed from iCloud\. (Your )?notes stay here/i)
  })

  it('asks a device whose vault key was changed elsewhere to join again, and shows no code', async () => {
    for (const shown of [
      snapshot({ transport: 'relay', enrolled: true, rotated: true }),
      snapshot({
        transport: 'relay',
        enrolled: true,
        status: { state: 'stopped', code: 'E_SYNC_VAULT_ROTATED' },
      }),
    ]) {
      const el = await show(shown, NO_CONTAINER, phone)
      expect(el.textContent).toMatch(/key was changed on another device/)
      expect(button(el, 'Join')).toBeDefined()
      expect(button(el, 'Show Pairing Code')).toBeUndefined()
      expect(button(el, 'Change Vault Key…')).toBeUndefined()
      act(() => root?.unmount())
      root = undefined
    }
  })

  it('cancels leaving without a word to Rust, and offers it to no relay vault', async () => {
    const el = await show(snapshot({}), ICLOUD, phone)
    await act(async () => button(el, 'Leave This Vault…')?.click())
    await act(async () => button(el, 'Cancel')?.click())
    expect(el.querySelector('input[type=text]')).toBeNull()
    expect(button(el, 'Leave This Vault…')).toBeDefined()
    expect(calls.some((c) => c.cmd === 'sync_icloud_leave')).toBe(false)
    act(() => root?.unmount())
    root = undefined
    const relay = await show(snapshot({ transport: 'relay', enrolled: true }), ICLOUD, phone)
    expect(button(relay, 'Leave This Vault…')).toBeUndefined()
  })
})

it('points the key field at its hint only when there is one', async () => {
  const shown = enPhone['syncSettings.icloudLeaveKeyHint']
  enPhone['syncSettings.icloudLeaveKeyHint'] = ''
  try {
    const el = await show(snapshot({}), ICLOUD, true)
    await act(async () => button(el, 'Leave This Vault…')?.click())
    const key = el.querySelector<HTMLInputElement>('input[type=text]')
    expect(key).not.toBeNull()
    expect(key?.hasAttribute('aria-describedby')).toBe(false)
  } finally {
    Object.assign(enPhone, { 'syncSettings.icloudLeaveKeyHint': shown })
  }
})

describe('Change Vault Key', () => {
  it('changes a relay vault\u2019s key once the relay\u2019s secret is typed, then shows the new recovery key', async () => {
    const el = await show(snapshot({ transport: 'relay', enrolled: true }), NO_CONTAINER, false)
    expect(el.querySelector('input[type=password]')).toBeNull()
    await act(async () => button(el, 'Change Vault Key…')?.click())
    const field = el.querySelector<HTMLInputElement>('input[type=password]')
    expect(field).not.toBeNull()
    expect(button(el, 'Change Key')?.disabled).toBe(true)
    if (!field) return
    type(field, 'wrong')
    await act(async () => button(el, 'Change Key')?.click())
    await settle()
    expect(el.textContent).toMatch(/could not be changed\. The relay did not accept that secret/)
    type(field, 'relay-secret')
    await act(async () => button(el, 'Change Key')?.click())
    await settle()
    expect(calls.filter((c) => c.cmd === 'sync_vault_rotate').map((c) => c.args)).toEqual([
      { relaySecret: 'wrong' },
      { relaySecret: 'relay-secret' },
    ])
    expect(el.textContent).toContain('ABCDE-FGHIJ-KLMNO')
    expect(el.querySelector('input[type=password]')).toBeNull()
    expect(button(el, 'Change Vault Key…')).toBeDefined()
  })

  it('cancels without a word to Rust', async () => {
    const el = await show(snapshot({ transport: 'relay', enrolled: true }), NO_CONTAINER, false)
    await act(async () => button(el, 'Change Vault Key…')?.click())
    await act(async () => button(el, 'Cancel')?.click())
    expect(el.querySelector('input[type=password]')).toBeNull()
    expect(calls.some((c) => c.cmd === 'sync_vault_rotate')).toBe(false)
  })

  it('is offered on the Mac for a relay vault only', async () => {
    for (const [shown, icloud, phone] of [
      [snapshot({ transport: 'relay', enrolled: true }), NO_CONTAINER, true],
      [snapshot({}), ICLOUD, false],
      [snapshot({ transport: 'relay', enrolled: false }), NO_CONTAINER, false],
    ] as const) {
      const el = await show(shown, icloud, phone)
      expect(button(el, 'Change Vault Key…')).toBeUndefined()
      act(() => root?.unmount())
      root = undefined
    }
  })
})
