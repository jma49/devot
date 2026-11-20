// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { CheckResult } from '../../clipper/setup'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'

async function open(
  options: {
    granted?: boolean
    request?: () => Promise<boolean>
    writeText?: (text: string) => Promise<void>
    check?: { value?: CheckResult; error?: string }
    stored?: Record<string, unknown>
  } = {},
) {
  vi.resetModules()
  const html = readFileSync(join(__dirname, '../../clipper/options.html'), 'utf8')
  document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*)<script/)![1]!
  const stored: Record<string, unknown> = { ...options.stored }
  const sendMessage = vi.fn<(request: unknown) => Promise<unknown>>(
    async () => options.check ?? { error: 'E_CLIP_CONNECTION' },
  )
  vi.stubGlobal('navigator', {
    clipboard: { writeText: options.writeText ?? (async () => {}) },
  })
  vi.stubGlobal('chrome', {
    i18n: { getMessage: (key: string) => key, getUILanguage: () => 'en' },
    storage: {
      local: {
        get: async () => stored,
        set: async (values: Record<string, unknown>) => Object.assign(stored, values),
      },
    },
    permissions: {
      contains: async () => options.granted ?? false,
      request: options.request ?? (async () => true),
    },
    runtime: { getURL: () => `${ORIGIN}/`, sendMessage },
  })
  await import('../../clipper/options')
  return { stored, sendMessage }
}

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!

it.each([true, false])(
  'asks for image downloads from the options tab (granted: %s)',
  async (granted) => {
    const request = vi.fn<() => Promise<boolean>>(async () => granted)
    await open({ request })
    await vi.waitFor(() => expect($('#images').hidden).toBe(false))
    $('#images').click()
    await vi.waitFor(() =>
      expect($('#images-state').textContent).toBe(granted ? 'imagesEnabled' : 'imagesRemote'),
    )
    expect(request).toHaveBeenCalledWith({
      origins: ['http://*/*', 'https://*/*'],
    })
    expect($('#images').hidden).toBe(granted)
  },
)

it('shows image downloads as on when already allowed', async () => {
  await open({ granted: true })
  await vi.waitFor(() => expect($('#images-state').textContent).toBe('imagesEnabled'))
  expect($('#images').hidden).toBe(true)
})

it.each([true, false])('shows and copies its own origin (copy succeeds: %s)', async (succeeds) => {
  const writeText = vi.fn<(text: string) => Promise<void>>(async () => {
    if (!succeeds) throw new Error('refused')
  })
  await open({ writeText })
  expect($<HTMLInputElement>('#origin').value).toBe(ORIGIN)
  expect($<HTMLInputElement>('#origin').readOnly).toBe(true)
  $('#copy-origin').click()
  await vi.waitFor(() =>
    expect($('#status').textContent).toBe(succeeds ? 'originCopied' : 'E_CLIP_COPY'),
  )
  expect($('#copy-origin').textContent).toBe(succeeds ? 'copied' : 'copyOrigin')
  expect(writeText).toHaveBeenCalledWith(ORIGIN)
})

it('reveals the token on request', async () => {
  await open({ stored: { token: 'dvt_secret' } })
  await vi.waitFor(() => expect($<HTMLInputElement>('#token').value).toBe('dvt_secret'))
  expect($<HTMLInputElement>('#token').type).toBe('password')
  $('#reveal').click()
  expect($<HTMLInputElement>('#token').type).toBe('text')
  expect($('#reveal').textContent).toBe('hideToken')
})

it('saves the settings, then lists each check up to the one that failed with its fix', async () => {
  const { stored, sendMessage } = await open({
    check: {
      value: {
        passed: ['connection'],
        failed: { check: 'origin', code: 'E_HTTP_ORIGIN_REFUSED' },
        notebooks: 0,
      },
    },
  })
  await vi.waitFor(() => expect($<HTMLButtonElement>('#save').disabled).toBe(false))
  expect($<HTMLInputElement>('#port').value).toBe('27484')
  $<HTMLInputElement>('#token').value = ' dvt_secret '
  $<HTMLFormElement>('#settings').requestSubmit()
  await vi.waitFor(() => expect($('#checks').hidden).toBe(false))
  expect(stored).toEqual({ port: 27484, token: 'dvt_secret' })
  expect(sendMessage).toHaveBeenCalledWith({ kind: 'check' })
  const items = [...document.querySelectorAll<HTMLLIElement>('#checks li')]
  expect(items.map((item) => item.dataset['state'])).toEqual([
    'passed',
    'failed',
    'waiting',
    'waiting',
    'waiting',
  ])
  expect(items[1]!.textContent).toBe('checkOriginE_HTTP_ORIGIN_REFUSED')
  expect($('#status').textContent).toBe('E_HTTP_ORIGIN_REFUSED')
})

it('says all is set when every check passes', async () => {
  await open({
    stored: { token: 'dvt_secret', port: 27484 },
    check: {
      value: {
        passed: ['connection', 'origin', 'token', 'write', 'notebooks'],
        notebooks: 3,
      },
    },
  })
  await vi.waitFor(() => expect($<HTMLButtonElement>('#save').disabled).toBe(false))
  $<HTMLFormElement>('#settings').requestSubmit()
  await vi.waitFor(() => expect($('#checks .connected').textContent).toBe('connected'))
  expect($('#checks li:nth-child(5)').textContent).toBe('checkNotebooksCount')
})

it('flags a missing token without asking Devot', async () => {
  const { sendMessage } = await open()
  await vi.waitFor(() => expect($<HTMLButtonElement>('#save').disabled).toBe(false))
  $<HTMLFormElement>('#settings').requestSubmit()
  await vi.waitFor(() => expect($('#status').textContent).toBe('E_CLIP_SETTINGS'))
  expect(sendMessage).not.toHaveBeenCalled()
})
