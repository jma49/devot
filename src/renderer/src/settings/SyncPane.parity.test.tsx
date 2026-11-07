// @vitest-environment happy-dom
// The phone layout of Settings > Sync, group by group, against tests/fixtures/sync-pane.json:
// the native Sync pane's SyncLayoutTests read the same cases.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { setIPhoneWording, t, type MessageKey } from '../i18n'
import { OnPhone } from './onPhone'
import { SyncSection } from './SyncSection'
import { SYNC_CHANGED } from '../sync'
import { settle } from '../../../../tests/support/render-hook'
import shared from '../../../../tests/fixtures/sync-pane.json'

vi.hoisted(() => vi.stubGlobal('DEVOT_UI_TEST', true))

interface Case {
  name: string
  snapshot: Record<string, unknown>
  icloud: Record<string, unknown>
  usage: Record<string, unknown> | null
  devices: Record<string, unknown>[]
  sections: { labels: MessageKey[]; notes: MessageKey[]; footer: MessageKey | null }[]
}

const cases = shared.cases as Case[]

const shown: { case?: Case } = {}

vi.mock('../ipc', () => ({
  invoke: vi.fn<(cmd: string) => Promise<unknown>>(async (cmd) => {
    const now = shown.case!
    switch (cmd) {
      case 'licence_get':
        return { gated: false, state: 'none', code: null, id: null, licensee: null, plan: null }
      case 'sync_get':
        return now.snapshot
      case 'sync_icloud_status':
        return now.icloud
      case 'sync_recovery_key':
        return null
      case 'sync_devices':
        return now.devices
      case 'sync_icloud_storage':
        return 2_500_000
      case 'sync_usage':
        if (now.usage) return now.usage
        throw new Error('E_SYNC_OFFLINE')
      default:
        throw new Error('E_SYNC_OFFLINE')
    }
  }),
}))

let root: Root | undefined

afterEach(() => {
  if (root) act(() => root?.unmount())
  root = undefined
  document.body.replaceChildren()
  setIPhoneWording(false)
})

const upToPlaceholder = (key: MessageKey) => t(key).split('{')[0]!

const text = (el: Element) => el.textContent?.trim() ?? ''

it.each(cases.map((c) => [c.name, c] as const))('lays out Sync on the phone: %s', async (_, c) => {
  shown.case = c
  setIPhoneWording(true)
  const host = document.createElement('div')
  document.body.append(host)
  const r = createRoot(host)
  root = r
  act(() =>
    r.render(
      <OnPhone.Provider value={true}>
        <SyncSection />
      </OnPhone.Provider>,
    ),
  )
  await settle()
  act(() => window.dispatchEvent(new CustomEvent(SYNC_CHANGED, { detail: c.snapshot })))
  await settle()
  await settle()
  const groups = [...host.querySelectorAll('.settings-block')].map((group) => {
    const own = (selector: string) =>
      [...group.querySelectorAll(selector)].filter((el) => !el.closest('.sync-devices')).map(text)
    return {
      labels: own('.setting-label'),
      notes: own('.settings-note'),
      footer: group.querySelector('.phone-footnote')
        ? text(group.querySelector('.phone-footnote')!)
        : null,
    }
  })
  expect(groups.map((group) => group.labels)).toEqual(
    c.sections.map((section) => section.labels.map((key) => t(key))),
  )
  groups.forEach((group, i) => {
    const want = c.sections[i]!
    expect(group.notes).toHaveLength(want.notes.length)
    want.notes.forEach((key, n) =>
      expect(group.notes[n]).toMatch(new RegExp(`^${escape(upToPlaceholder(key))}`)),
    )
    const footer = want.footer === null ? null : upToPlaceholder(want.footer)
    expect(group.footer?.slice(0, footer?.length ?? 0) ?? null).toBe(footer)
  })
})

function escape(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
