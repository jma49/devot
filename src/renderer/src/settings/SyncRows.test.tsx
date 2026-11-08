// @vitest-environment happy-dom
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { t } from '../i18n'
import { settle } from '../../../../tests/support/render-hook'
import { LeaveICloudRow } from './SyncICloud'
import { ICloudRotateKeyRow, RotateKeyRow } from './SyncRotate'

vi.hoisted(() => vi.stubGlobal('DEVOT_UI_TEST', true))

let reject: (e: Error) => void = () => {}

vi.mock('../ipc', () => ({
  invoke: vi.fn<() => Promise<unknown>>(
    () =>
      new Promise((_, no) => {
        reject = no
      }),
  ),
}))

let root: Root | undefined
let host: HTMLElement | undefined

afterEach(() => {
  if (root) act(() => root?.unmount())
  host?.remove()
  root = undefined
})

function show(row: ReactElement): HTMLElement {
  host = document.createElement('div')
  document.body.append(host)
  const r = createRoot(host)
  root = r
  act(() => r.render(row))
  return host
}

const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
const press = (target: Element, key: string) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
const type = (input: HTMLInputElement, text: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })

function escapeWhileRunning(row: ReactElement, opener: string, typed: string) {
  const el = show(row)
  act(() => button(el, opener)?.click())
  const field = el.querySelector('input') as HTMLInputElement
  type(field, typed)
  press(field, 'Enter')
  press(field, 'Escape')
  expect(el.querySelector('input')).toBe(field)
  expect(button(el, t('dialog.cancel'))?.disabled).toBe(true)
  return { el, field }
}

describe('a sync row while its request runs', () => {
  it('keeps Leave iCloud Vault open on Escape, and the typed key after a failure', async () => {
    const failed = vi.fn<(e: unknown) => void>()
    const { el, field } = escapeWhileRunning(
      <LeaveICloudRow onLeft={() => {}} failed={() => failed} />,
      `${t('syncSettings.icloudLeave')}…`,
      'THIS-VAULT',
    )
    act(() => reject(new Error('E_SYNC_OFFLINE')))
    await settle()
    expect(failed).toHaveBeenCalledOnce()
    expect(el.querySelector('input')).toBe(field)
    expect(field.value).toBe('THIS-VAULT')
    press(field, 'Escape')
    expect(el.querySelector('input')).toBeNull()
  })

  it('keeps Change Vault Key open on Escape, and the typed secret after a failure', async () => {
    const failed = vi.fn<(e: unknown) => void>()
    const { el, field } = escapeWhileRunning(
      <RotateKeyRow onRotated={() => {}} failed={() => failed} />,
      `${t('syncSettings.rotate')}…`,
      'relay-secret',
    )
    act(() => reject(new Error('E_SYNC_OFFLINE')))
    await settle()
    expect(failed).toHaveBeenCalledOnce()
    expect(el.querySelector('input')).toBe(field)
    expect(field.value).toBe('relay-secret')
  })

  it('keeps the iCloud Change Vault Key confirmation on Escape', async () => {
    const failed = vi.fn<(e: unknown) => void>()
    const el = show(<ICloudRotateKeyRow onRotated={() => {}} failed={() => failed} />)
    act(() => button(el, `${t('syncSettings.rotate')}…`)?.click())
    const confirm = button(el, t('syncSettings.rotateButton')) as HTMLButtonElement
    act(() => confirm.click())
    press(confirm, 'Escape')
    expect(button(el, t('syncSettings.rotateButton'))).toBe(confirm)
    act(() => reject(new Error('E_SYNC_OFFLINE')))
    await settle()
    expect(failed).toHaveBeenCalledOnce()
    expect(button(el, t('syncSettings.rotateButton'))).toBe(confirm)
  })
})
