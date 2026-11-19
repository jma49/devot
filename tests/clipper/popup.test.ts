// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import en from '../../clipper/_locales/en/messages.json'
import zh from '../../clipper/_locales/zh_CN/messages.json'

afterEach(() => vi.unstubAllGlobals())

it.each([
  ['en', en, 'notebooks'],
  ['en', en, 'save'],
  ['zh_CN', zh, 'notebooks'],
  ['zh_CN', zh, 'save'],
] as const)(
  'shows the exact origin refusal code in %s (case %#)',
  async (_locale, catalog, refused) => {
    vi.resetModules()
    document.body.innerHTML = readFileSync(
      join(__dirname, '../../clipper/popup.html'),
      'utf8',
    ).match(/<main>[\s\S]*<\/main>/)![0]
    vi.stubGlobal('chrome', {
      permissions: { contains: async () => true },
      i18n: {
        getMessage: (key: string) =>
          (catalog as Record<string, { message: string }>)[key]?.message ?? '',
        getUILanguage: () => 'en',
      },
      tabs: { query: async () => [{ id: 1, title: 'Article' }] },
      runtime: {
        sendMessage: async ({ kind }: { kind: string }) =>
          kind === refused
            ? { error: 'E_HTTP_ORIGIN_REFUSED' }
            : { value: [{ id: 'book', name: 'Clippings' }] },
      },
      scripting: {
        executeScript: async () => [{ result: { value: { title: 'Article', markdown: 'Body' } } }],
      },
    })
    await import('../../clipper/popup')
    await vi.waitFor(() =>
      expect(document.querySelector('#status')?.textContent).toBe(
        refused === 'save' ? catalog.ready.message : 'E_HTTP_ORIGIN_REFUSED',
      ),
    )
    if (refused === 'save') {
      const button = document.querySelector<HTMLButtonElement>('button[data-mode="article"]')!
      button.click()
    }
    await vi.waitFor(() =>
      expect(document.querySelector('#status')?.textContent).toBe('E_HTTP_ORIGIN_REFUSED'),
    )
  },
)

it.each([undefined, 'My headline', ''])(
  'uses the extracted headline unless the title was edited to %s',
  async (edited) => {
    vi.resetModules()
    document.body.innerHTML = readFileSync(
      join(__dirname, '../../clipper/popup.html'),
      'utf8',
    ).match(/<main>[\s\S]*<\/main>/)![0]
    const sendMessage = vi.fn<(request: { kind: string }) => Promise<{ value: unknown }>>(
      async (request) => ({
        value: request.kind === 'notebooks' ? [{ id: 'book', name: 'Clippings' }] : { id: 'note' },
      }),
    )
    const executeScript = vi.fn<(request: { files?: string[] }) => Promise<unknown[]>>(
      async (request) =>
        request.files ? [] : [{ result: { value: { title: 'Lighthouse', markdown: 'Article' } } }],
    )
    vi.stubGlobal('chrome', {
      permissions: { contains: async () => true },
      i18n: { getMessage: (key: string) => key, getUILanguage: () => 'en' },
      tabs: { query: async () => [{ id: 1, title: 'Lighthouse - Wikipedia' }] },
      runtime: { sendMessage },
      scripting: { executeScript },
    })
    await import('../../clipper/popup')
    const button = document.querySelector<HTMLButtonElement>('button[data-mode="article"]')!
    await vi.waitFor(() => expect(button.disabled).toBe(false))
    if (edited !== undefined) {
      const title = document.querySelector<HTMLInputElement>('#title')!
      title.value = edited
      title.dispatchEvent(new Event('input'))
    }
    button.click()
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        kind: 'save',
        images: true,
        note: { title: edited?.trim() || 'Lighthouse', markdown: 'Article', notebook: 'book' },
      }),
    )
  },
)
