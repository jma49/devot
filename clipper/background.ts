import { ApiClient, type Note, type Settings } from './client'
import { extension as chrome } from './platform'

export type Request = { kind: 'notebooks' } | { kind: 'save'; note: Note }
chrome.runtime.onMessage.addListener((request: Request, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab) return false
  void (async () => {
    const stored = await chrome.storage.local.get(['port', 'token'])
    const settings: Settings = {
      port: Number(stored['port'] ?? 27484),
      token: String(stored['token'] ?? ''),
    }
    const client = new ApiClient(settings, chrome.runtime.getURL('').replace(/\/$/, ''))
    return request.kind === 'notebooks' ? client.notebooks() : client.save(request.note)
  })().then(
    (value) => respond({ value }),
    (error: unknown) => respond({ error: error instanceof Error ? error.message : 'E_CLIP_API' }),
  )
  return true
})
