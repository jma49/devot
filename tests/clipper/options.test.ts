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
