// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => vi.unstubAllGlobals())

it.each([true, false])(
  'requests optional image access from the persistent options tab (granted: %s)',
  async (granted) => {
    vi.resetModules()
    document.body.innerHTML = readFileSync(
      join(__dirname, '../../clipper/options.html'),
      'utf8',
    ).match(/<main>[\s\S]*<\/main>/)![0]
    const request = vi.fn<() => Promise<boolean>>().mockResolvedValue(granted)
    vi.stubGlobal('chrome', {
      i18n: { getMessage: (key: string) => key, getUILanguage: () => 'en' },
      storage: { local: { get: async () => ({ port: 27484, token: 'secret' }) } },
      permissions: { contains: async () => false, request },
      runtime: { getURL: () => 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/' },
    })
    await import('../../clipper/options')
    const button = document.querySelector<HTMLButtonElement>('#images')!
    expect(button).not.toBeNull()
    button.click()
    await vi.waitFor(() =>
      expect(document.querySelector('#status')?.textContent).toBe(
        granted ? 'imagesEnabled' : 'imagesRemote',
      ),
    )
    expect(request).toHaveBeenCalledWith({ origins: ['http://*/*', 'https://*/*'] })
    expect(button.disabled).toBe(granted)
  },
)

it.each([
  ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/', true],
  ['moz-extension://12345678-1234-4abc-8def-123456789abc/', true],
  ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/', false],
])('shows and copies its own origin: %s (copy succeeds: %s)', async (url, succeeds) => {
  vi.resetModules()
  document.body.innerHTML = readFileSync(
    join(__dirname, '../../clipper/options.html'),
    'utf8',
  ).match(/<main>[\s\S]*<\/main>/)![0]
  const writeText = vi.fn<(text: string) => Promise<void>>(async () => {
    if (!succeeds) throw new Error('refused')
  })
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  vi.stubGlobal('chrome', {
    i18n: { getMessage: (key: string) => key, getUILanguage: () => 'en' },
    runtime: { getURL: () => url },
    storage: { local: { get: async () => ({}) } },
    permissions: { contains: async () => false },
  })
  await import('../../clipper/options')
  const origin = document.querySelector<HTMLInputElement>('#origin')
  expect(origin?.value).toBe(url.replace(/\/$/, ''))
  expect(origin?.readOnly).toBe(true)
  expect(document.querySelector('[data-i18n="registerOrigin"]')?.textContent).toBe('registerOrigin')
  document.querySelector<HTMLButtonElement>('#copy-origin')!.click()
  await vi.waitFor(() =>
    expect(document.querySelector('#status')?.textContent).toBe(
      succeeds ? 'originCopied' : 'E_CLIP_COPY',
    ),
  )
  expect(writeText).toHaveBeenCalledWith(url.replace(/\/$/, ''))
})
