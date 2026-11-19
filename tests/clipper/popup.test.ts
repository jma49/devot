// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { messages as en } from '../../src/renderer/src/i18n/en/clipper'
import { messages as zh } from '../../src/renderer/src/i18n/zh-Hans/clipper'

afterEach(() => vi.unstubAllGlobals())

it.each([
  ['en', en, 'notebooks'],
  ['en', en, 'save'],
  ['zh_CN', zh, 'notebooks'],
  ['zh_CN', zh, 'save'],
] as const)(
  'shows the localized registration instruction in %s (case %#)',
  async (_locale, catalog, refused) => {
    vi.resetModules()
    document.body.innerHTML = readFileSync(
      join(__dirname, '../../clipper/popup.html'),
      'utf8',
    ).match(/<main>[\s\S]*<\/main>/)![0]
    vi.stubGlobal('chrome', {
      permissions: { contains: async () => true },
      i18n: {
        getMessage: (key: string) => (catalog as Record<string, string>)[`clipper.${key}`] ?? '',
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
        refused === 'save' ? catalog['clipper.ready'] : catalog['clipper.E_HTTP_ORIGIN_REFUSED'],
      ),
    )
    if (refused === 'save') {
      const button = document.querySelector<HTMLButtonElement>('button[data-mode="article"]')!
      button.click()
    }
    await vi.waitFor(() =>
      expect(document.querySelector('#status')?.textContent).toBe(
        catalog['clipper.E_HTTP_ORIGIN_REFUSED'],
      ),
    )
    expect(document.querySelector('#status')?.textContent).not.toContain('E_HTTP_ORIGIN_REFUSED')
    expect(document.querySelector('#status')?.textContent).toContain('Devot')
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
