// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { messages as en } from '../../src/renderer/src/i18n/en/clipper'
import { messages as zh } from '../../src/renderer/src/i18n/zh-Hans/clipper'

afterEach(() => vi.unstubAllGlobals())

type Catalog = Record<string, string>
const keys = (key: string) => key

function page(): void {
  const html = readFileSync(join(__dirname, '../../clipper/popup.html'), 'utf8')
  document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*)<script/)![1]!
}

interface Options {
  getMessage?: (key: string) => string
  url?: string
  selection?: boolean
  notebooks?: { value?: unknown; error?: string }
  extracted?: { value?: { title: string; markdown: string }; error?: string }
  saveUpdates?: unknown[]
  stored?: Record<string, unknown>
  navigated?: boolean
}

function stub(options: Options = {}) {
  const posted: unknown[] = []
  const injected: string[] = []
  const firstExtract = options.navigated ? [{ missing: true }] : []
  const stored: Record<string, unknown> = { ...options.stored }
  const update = vi.fn<(id: number, change: { url: string }) => Promise<unknown>>(async () => ({}))
  const openOptionsPage = vi.fn<() => Promise<void>>(async () => {})
  vi.stubGlobal('chrome', {
    i18n: {
      getMessage: options.getMessage ?? keys,
      getUILanguage: () => 'en',
    },
    tabs: {
      query: async () => [
        {
          id: 1,
          title: 'Lighthouse - Wikipedia',
          url: options.url ?? 'https://example.org/a',
        },
      ],
      update,
    },
    permissions: { contains: async () => true },
    storage: {
      local: {
        get: async () => stored,
        set: async (values: Record<string, unknown>) => Object.assign(stored, values),
      },
    },
    scripting: {
      executeScript: async (request: { files?: string[]; args?: unknown[] }) =>
        request.files
          ? (injected.push(request.files[0]!), [])
          : request.args
            ? [
                {
                  result: firstExtract.shift() ??
                    options.extracted ?? {
                      value: { title: 'Lighthouse', markdown: 'Body' },
                    },
                },
              ]
            : [
                {
                  result: {
                    title: 'Lighthouse',
                    selection: options.selection ?? false,
                  },
                },
              ],
    },
    runtime: {
      openOptionsPage,
      sendMessage: async () =>
        options.notebooks ?? {
          value: [
            { id: 'inbox', name: 'Inbox', notes: 0 },
            { id: 'reading', name: 'Reading', notes: 2 },
          ],
        },
      connect: () => {
        const listeners: ((update: unknown) => void)[] = []
        return {
          onMessage: {
            addListener: (listener: (update: unknown) => void) => listeners.push(listener),
          },
          onDisconnect: { addListener: () => {} },
          disconnect: () => {},
          postMessage: (request: unknown) => {
            posted.push(request)
            for (const saveUpdate of options.saveUpdates ?? [
              { kind: 'images', done: 1, total: 2 },
              { kind: 'saved', saved: { id: 'note-1', imagesKept: false } },
            ])
              setTimeout(() => listeners.forEach((listener) => listener(saveUpdate)))
          },
        }
      },
    },
  })
  return { posted, stored, update, openOptionsPage, injected }
}

const text = (id: string) => document.getElementById(id)?.textContent
const visible = (id: string) => !document.getElementById(id)?.hasAttribute('hidden')

async function open(options: Options = {}) {
  vi.resetModules()
  page()
  const spies = stub(options)
  await import('../../clipper/popup')
  return spies
}

it.each([
  ['en', en],
  ['zh_CN', zh],
] as const)('asks to finish setup in %s when Devot refuses the extension', async (_, catalog) => {
  const { openOptionsPage } = await open({
    getMessage: (key) => (catalog as Catalog)[`clipper.${key}`] ?? '',
    notebooks: { error: 'E_HTTP_ORIGIN_REFUSED' },
  })
  await vi.waitFor(() => expect(visible('message')).toBe(true))
  expect(visible('clip')).toBe(false)
  expect(text('message-title')).toBe(catalog['clipper.setupTitle'])
  expect(text('message-text')).toBe(catalog['clipper.E_HTTP_ORIGIN_REFUSED'])
  expect(text('status')).toContain(catalog['clipper.E_HTTP_ORIGIN_REFUSED'])
  document.getElementById('message-primary')!.click()
  expect(openOptionsPage).toHaveBeenCalled()
})

it('offers to try again when Devot cannot be reached', async () => {
  await open({ notebooks: { error: 'E_CLIP_CONNECTION' } })
  await vi.waitFor(() => expect(text('message-primary')).toBe('retry'))
  expect(text('message-secondary')).toBe('openSettings')
})

it('refuses a page that is not a web page without asking Devot', async () => {
  await open({ url: 'chrome://extensions/' })
  await vi.waitFor(() => expect(text('message-title')).toBe('E_CLIP_URL'))
  expect(visible('clip')).toBe(false)
})

it('shows the cleaned title, the host and the last notebook, then saves with progress', async () => {
  const { posted, stored, update } = await open({
    stored: { notebook: 'reading' },
  })
  await vi.waitFor(() => expect(visible('clip')).toBe(true))
  expect(document.querySelector<HTMLTextAreaElement>('#title')!.value).toBe('Lighthouse')
  expect(text('host')).toBe('example.org')
  expect(document.querySelector<HTMLSelectElement>('#notebook')!.value).toBe('reading')
  expect(document.querySelector<HTMLInputElement>('#mode-selection')!.disabled).toBe(true)
  expect(visible('selection-none')).toBe(true)
  document.querySelector<HTMLFormElement>('#clip')!.requestSubmit()
  await vi.waitFor(() => expect(text('progress-text')).toBe('workingImages'))
  await vi.waitFor(() => expect(visible('message-done')).toBe(true))
  expect(posted).toEqual([
    {
      images: true,
      source: 'https://example.org/a',
      note: { title: 'Lighthouse', markdown: 'Body', notebook: 'reading' },
    },
  ])
  expect(stored['notebook']).toBe('reading')
  expect(text('message-title')).toBe('saved')
  expect(visible('message-note')).toBe(false)
  document.getElementById('message-primary')!.click()
  expect(update).toHaveBeenCalledWith(1, { url: 'devot://note/note-1' })
})

it('keeps an edited title and starts on Selection when the page has one', async () => {
  const { posted } = await open({ selection: true })
  await vi.waitFor(() => expect(visible('clip')).toBe(true))
  expect(document.querySelector<HTMLInputElement>('#mode-selection')!.checked).toBe(true)
  expect(visible('selection-none')).toBe(false)
  const title = document.querySelector<HTMLTextAreaElement>('#title')!
  title.value = '  My headline '
  title.dispatchEvent(new Event('input'))
  document.querySelector<HTMLFormElement>('#clip')!.requestSubmit()
  await vi.waitFor(() => expect(posted).toHaveLength(1))
  expect(posted[0]).toMatchObject({ note: { title: 'My headline' } })
})

it('says when images stayed remote, and how to keep them', async () => {
  await open({
    saveUpdates: [{ kind: 'saved', saved: { id: 'n', imagesKept: true } }],
  })
  await vi.waitFor(() => expect(visible('clip')).toBe(true))
  document.querySelector<HTMLFormElement>('#clip')!.requestSubmit()
  await vi.waitFor(() => expect(text('message-note')).toBe('imagesFailed'))
})

it('keeps the form with the problem when the page has nothing to clip', async () => {
  await open({ extracted: { error: 'E_CLIP_EMPTY' } })
  await vi.waitFor(() => expect(visible('clip')).toBe(true))
  document.querySelector<HTMLFormElement>('#clip')!.requestSubmit()
  await vi.waitFor(() => expect(visible('problem')).toBe(true))
  expect(text('problem-text')).toBe('E_CLIP_EMPTY')
  expect(document.querySelector<HTMLButtonElement>('#save')!.disabled).toBe(false)
})

it('turns a refused save into the setup message', async () => {
  await open({ saveUpdates: [{ kind: 'failed', code: 'E_HTTP_READ_ONLY' }] })
  await vi.waitFor(() => expect(visible('clip')).toBe(true))
  document.querySelector<HTMLFormElement>('#clip')!.requestSubmit()
  await vi.waitFor(() => expect(text('message-text')).toBe('E_HTTP_READ_ONLY'))
})

it('injects the extractor once, and again only when the page lost it', async () => {
  for (const navigated of [false, true]) {
    const { injected, posted } = await open({ navigated })
    await vi.waitFor(() => expect(visible('clip')).toBe(true))
    document.querySelector<HTMLFormElement>('#clip')!.requestSubmit()
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    expect(injected).toEqual(navigated ? ['content.js', 'content.js'] : ['content.js'])
  }
})
