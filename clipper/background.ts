import { ApiClient, type Note, type Saved, type Settings } from './client'
import { check } from './setup'
import { extension as chrome } from './platform'

export type Request = { kind: 'notebooks' } | { kind: 'check' }

export interface SaveRequest {
  note: Note
  images: boolean
}
export type SaveUpdate =
  | { kind: 'images'; done: number; total: number }
  | { kind: 'saved'; saved: Saved }
  | { kind: 'failed'; code: string }

const code = (error: unknown) => (error instanceof Error ? error.message : 'E_CLIP_API')

async function client(): Promise<ApiClient> {
  const stored = await chrome.storage.local.get(['port', 'token'])
  const settings: Settings = {
    port: Number(stored['port'] ?? 27484),
    token: String(stored['token'] ?? ''),
  }
  return new ApiClient(settings, chrome.runtime.getURL('').replace(/\/$/, ''))
}

const fromExtensionPage = (sender: chrome.runtime.MessageSender) =>
  sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(''))

chrome.runtime.onMessage.addListener((request: Request, sender, respond) => {
  if (!fromExtensionPage(sender)) return false
  void (async () => {
    const api = await client()
    return request.kind === 'notebooks' ? api.notebooks() : check(api)
  })().then(
    (value) => respond({ value }),
    (error: unknown) => respond({ error: code(error) }),
  )
  return true
})

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'save' || !port.sender || !fromExtensionPage(port.sender)) return
  let open = true
  port.onDisconnect.addListener(() => {
    open = false
  })
  const post = (update: SaveUpdate) => {
    if (open) port.postMessage(update)
  }
  port.onMessage.addListener((request: SaveRequest) => {
    void (async () => {
      const api = await client()
      return api.save(request.note, request.images, (done, total) =>
        post({ kind: 'images', done, total }),
      )
    })().then(
      (saved) => post({ kind: 'saved', saved }),
      (error: unknown) => post({ kind: 'failed', code: code(error) }),
    )
  })
})

chrome.runtime.onInstalled?.addListener(({ reason }) => {
  if (reason === 'install') void chrome.runtime.openOptionsPage()
})
