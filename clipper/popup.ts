import type { Request, SaveRequest, SaveUpdate } from './background'
import type { Notebook, Saved } from './client'
import type { Clip, Mode } from './extract'
import { field, localize, message, show } from './ui'
import { extension as chrome } from './platform'

const IMAGE_ORIGINS = ['http://*/*', 'https://*/*']
const SETUP_CODES = new Set([
  'E_CLIP_SETTINGS',
  'E_CLIP_CONNECTION',
  'E_CLIP_NOTEBOOKS',
  'E_HTTP_ORIGIN_REFUSED',
  'E_HTTP_TOKEN_MISSING',
  'E_HTTP_TOKEN_INVALID',
  'E_HTTP_READ_ONLY',
])

type View =
  | { kind: 'loading' }
  | { kind: 'unclippable' }
  | { kind: 'setup'; code: string }
  | { kind: 'ready'; problem?: string }
  | { kind: 'saving'; done?: number; total?: number }
  | { kind: 'saved'; saved: Saved; notebook: string; imagesAllowed: boolean }

localize()
const form = field<HTMLFormElement>('clip')
const title = field<HTMLTextAreaElement>('title')
const notebook = field<HTMLSelectElement>('notebook')
const selection = field<HTMLInputElement>('mode-selection')
const status = field('status')
let titleEdited = false
let selectionAvailable = false
let tab: chrome.tabs.Tab | undefined
let view: View = { kind: 'loading' }

title.addEventListener('input', () => {
  titleEdited = true
})
title.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    form.requestSubmit()
  }
})

function announce(text: string): void {
  status.textContent = text
}

function showMessage(options: {
  done?: boolean
  title: string
  text?: string
  note?: string
  primary?: [string, () => void]
  secondary?: [string, () => void]
}): void {
  show(field('message-done'), !!options.done)
  show(field('message-problem'), !options.done)
  field('message-title').textContent = options.title
  field('message-text').textContent = options.text ?? ''
  show(field('message-text'), !!options.text)
  field('message-note').textContent = options.note ?? ''
  show(field('message-note'), !!options.note)
  for (const [id, action] of [
    ['message-primary', options.primary],
    ['message-secondary', options.secondary],
  ] as const) {
    const button = field<HTMLButtonElement>(id)
    show(button, !!action)
    button.textContent = action?.[0] ?? ''
    button.onclick = action ? action[1] : null
  }
  announce([options.title, options.text, options.note].filter(Boolean).join(' '))
}

const openSettings = () => void chrome.runtime.openOptionsPage()

function render(next: View): void {
  view = next
  document.body.dataset['view'] = next.kind
  const formShown = next.kind === 'ready' || next.kind === 'saving'
  show(form, formShown)
  show(field('message'), !formShown && next.kind !== 'loading')
  const busy = next.kind === 'saving'
  for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
    'textarea, select, input, button',
  ))
    control.disabled = busy || (control === selection && !selectionAvailable)
  show(field('progress'), busy)
  show(field('problem'), next.kind === 'ready' && !!next.problem)
  switch (next.kind) {
    case 'loading':
      announce(message('loading'))
      break
    case 'unclippable':
      showMessage({
        title: message('E_CLIP_URL'),
        secondary: [message('done'), () => close()],
      })
      break
    case 'setup':
      showMessage({
        title: message('setupTitle'),
        text: message(next.code),
        primary:
          next.code === 'E_CLIP_CONNECTION'
            ? [message('retry'), () => void load()]
            : [message('openSettings'), openSettings],
        ...(next.code === 'E_CLIP_CONNECTION'
          ? {
              secondary: [message('openSettings'), openSettings] as [string, () => void],
            }
          : {}),
      })
      break
    case 'ready':
      field('problem-text').textContent = next.problem ? message(next.problem) : ''
      announce(next.problem ? message(next.problem) : '')
      break
    case 'saving': {
      const bar = field<HTMLProgressElement>('progress-bar')
      const text =
        next.total === undefined
          ? message('working')
          : message('workingImages', {
              done: next.done ?? 0,
              total: next.total,
            })
      if (next.total === undefined) bar.removeAttribute('value')
      else {
        bar.max = next.total
        bar.value = next.done ?? 0
      }
      field('progress-text').textContent = text
      announce(text)
      break
    }
    case 'saved':
      showMessage({
        done: true,
        title: message('saved', { notebook: next.notebook }),
        text: title.value.trim(),
        ...(next.saved.imagesKept
          ? {
              note: message(next.imagesAllowed ? 'imagesFailed' : 'imagesKept'),
            }
          : {}),
        primary: [message('openNote'), () => openNote(next.saved.id)],
        secondary: [message('done'), () => close()],
      })
      break
  }
}

function openNote(id: string): void {
  // An external scheme hands off to the app without navigating the tab away from the article.
  if (tab?.id)
    void chrome.tabs.update(tab.id, {
      url: `devot://note/${encodeURIComponent(id)}`,
    })
  close()
}

async function send<T>(request: Request): Promise<T> {
  const result = (await chrome.runtime.sendMessage(request)) as
    | { value: T; error?: string }
    | undefined
  if (!result) throw new Error('E_CLIP_API')
  if (result.error) throw new Error(result.error)
  return result.value
}

function saveThroughBackground(request: SaveRequest): Promise<Saved> {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'save' })
    let settled = false
    port.onMessage.addListener((update: SaveUpdate) => {
      if (update.kind === 'images') {
        if (view.kind === 'saving')
          render({ kind: 'saving', done: update.done, total: update.total })
        return
      }
      settled = true
      port.disconnect()
      if (update.kind === 'saved') resolve(update.saved)
      else reject(new Error(update.code))
    })
    port.onDisconnect.addListener(() => {
      if (!settled) reject(new Error('E_CLIP_API'))
    })
    port.postMessage(request)
  })
}

async function extract(mode: Mode): Promise<Clip> {
  const tabId = tab?.id
  if (!tabId) throw new Error('E_CLIP_URL')
  const run = async () => {
    const [answer] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (selectedMode: Mode) => {
        const extractor = (
          globalThis as typeof globalThis & { devotExtract?: (mode: Mode) => Clip }
        ).devotExtract
        if (!extractor) return { missing: true }
        try {
          return { value: extractor(selectedMode) }
        } catch (error) {
          return { error: error instanceof Error ? error.message : 'E_CLIP_EMPTY' }
        }
      },
      args: [mode],
    })
    return answer?.result
  }
  // The script injected when the popup opened is gone if the page navigated since.
  let result = await run()
  if (result && 'missing' in result) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
    result = await run()
  }
  if (!result || !('value' in result) || !result.value)
    throw new Error((result && 'error' in result && result.error) || 'E_CLIP_EMPTY')
  return result.value
}

async function clip(): Promise<void> {
  if (view.kind !== 'ready') return
  const book = notebook.selectedOptions[0]
  if (!book) return
  render({ kind: 'saving' })
  try {
    const mode: Mode = selection.checked ? 'selection' : 'article'
    const imagesAllowed = await chrome.permissions.contains({
      origins: IMAGE_ORIGINS,
    })
    const result = await extract(mode)
    if (!titleEdited) title.value = result.title
    void chrome.storage.local.set({ notebook: book.value })
    const saved = await saveThroughBackground({
      images: imagesAllowed,
      note: {
        title: title.value.trim() || result.title,
        markdown: result.markdown,
        notebook: book.value,
      },
    })
    render({
      kind: 'saved',
      saved,
      notebook: book.textContent ?? '',
      imagesAllowed,
    })
  } catch (error) {
    const code = error instanceof Error ? error.message : 'E_CLIP_API'
    render(SETUP_CODES.has(code) ? { kind: 'setup', code } : { kind: 'ready', problem: code })
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault()
  void clip()
})
field('options').addEventListener('click', openSettings)
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.isComposing || document.activeElement !== document.body) return
  event.preventDefault()
  if (view.kind === 'ready') form.requestSubmit()
  else if (!field('message').hidden) {
    const primary = field<HTMLButtonElement>('message-primary')
    ;(primary.hidden ? field<HTMLButtonElement>('message-secondary') : primary).click()
  }
})

async function readTab(): Promise<boolean> {
  ;[tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  let url: URL | undefined
  try {
    url = new URL(tab?.url ?? '')
  } catch {
    url = undefined
  }
  if (!tab?.id || !url || !['http:', 'https:'].includes(url.protocol)) return false
  if (!titleEdited) title.value = tab.title ?? ''
  field('host').textContent = url.hostname.replace(/^www\./, '')
  const favicon = field<HTMLImageElement>('favicon')
  if (tab.favIconUrl && /^https?:|^data:image\//.test(tab.favIconUrl)) favicon.src = tab.favIconUrl
  else favicon.hidden = true
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    })
    const [answer] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () =>
        (
          globalThis as typeof globalThis & {
            devotPage: () => { title: string; selection: boolean }
          }
        ).devotPage(),
    })
    selectionAvailable = answer?.result?.selection === true
    if (!titleEdited && answer?.result?.title) title.value = answer.result.title
  } catch {
    return false
  }
  selection.checked = selectionAvailable
  field<HTMLInputElement>('mode-article').checked = !selectionAvailable
  show(field('selection-none'), !selectionAvailable)
  return true
}

async function load(): Promise<void> {
  render({ kind: 'loading' })
  try {
    if (!(await readTab())) {
      render({ kind: 'unclippable' })
      return
    }
    const [books, stored] = await Promise.all([
      send<Notebook[]>({ kind: 'notebooks' }),
      chrome.storage.local.get('notebook'),
    ])
    if (!books.length) throw new Error('E_CLIP_NOTEBOOKS')
    notebook.replaceChildren(
      ...books.map((book) => {
        const option = document.createElement('option')
        option.value = book.id
        option.textContent = book.name
        return option
      }),
    )
    if (books.some((book) => book.id === stored['notebook']))
      notebook.value = String(stored['notebook'])
    render({ kind: 'ready' })
  } catch (error) {
    render({
      kind: 'setup',
      code: error instanceof Error ? error.message : 'E_CLIP_API',
    })
  }
}

void load()
