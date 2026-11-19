import type { Request } from './background'
import type { Notebook } from './client'
import type { Clip, Mode } from './extract'
import { field, localize, status } from './ui'
import { extension as chrome } from './platform'

localize()
const title = field<HTMLInputElement>('title')
let titleEdited = false
title.addEventListener('input', () => {
  titleEdited = true
})
const notebook = field<HTMLSelectElement>('notebook')
const buttons = [...document.querySelectorAll<HTMLButtonElement>('button[data-mode]')]
let busy = false
function pending(value: boolean): void {
  busy = value
  for (const button of buttons) button.disabled = value || !notebook.value
}
async function send<T>(request: Request): Promise<T> {
  const result = (await chrome.runtime.sendMessage(request)) as { value: T; error?: string }
  if (result.error) throw new Error(result.error)
  return result.value
}
async function clip(mode: Mode): Promise<void> {
  if (busy) return
  pending(true)
  status('working')
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id) throw new Error('E_CLIP_URL')
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
    const [answer] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (selectedMode: Mode) => {
        try {
          const extract = (globalThis as typeof globalThis & { devotExtract: (mode: Mode) => Clip })
            .devotExtract
          return { value: extract(selectedMode) }
        } catch (error) {
          return { error: error instanceof Error ? error.message : 'E_CLIP_EMPTY' }
        }
      },
      args: [mode],
    })
    if (!answer?.result?.value) throw new Error(answer?.result?.error || 'E_CLIP_EMPTY')
    const result = answer.result.value
    await send({
      kind: 'save',
      note: {
        title: (titleEdited && title.value.trim()) || result.title,
        markdown: result.markdown,
        notebook: notebook.value,
      },
    })
    status('saved')
  } catch (error) {
    status(error instanceof Error ? error.message : 'E_CLIP_API')
  } finally {
    pending(false)
  }
}
for (const button of buttons)
  button.addEventListener('click', () => void clip(button.dataset['mode'] as Mode))
field('options').addEventListener('click', () => void chrome.runtime.openOptionsPage())
pending(true)
void (async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    title.value = tab?.title ?? ''
    const books = await send<Notebook[]>({ kind: 'notebooks' })
    for (const book of books) {
      const option = document.createElement('option')
      option.value = book.id
      option.textContent = book.name
      notebook.append(option)
    }
    status(books.length ? 'ready' : 'E_CLIP_NOTEBOOKS')
  } catch (error) {
    status(error instanceof Error ? error.message : 'E_CLIP_API')
  } finally {
    pending(false)
  }
})()
