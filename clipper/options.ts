import { field, localize, status } from './ui'
import { extension as chrome } from './platform'

localize()
const port = field<HTMLInputElement>('port')
const token = field<HTMLInputElement>('token')
const save = field<HTMLButtonElement>('save')
const images = field<HTMLButtonElement>('images')
void chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] }).then((granted) => {
  images.disabled = granted
})
images.addEventListener('click', () => {
  images.disabled = true
  void chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] }).then(
    (granted) => {
      images.disabled = granted
      status(granted ? 'imagesEnabled' : 'imagesRemote')
    },
    () => {
      images.disabled = false
      status('imagesRemote')
    },
  )
})
save.disabled = true
void chrome.storage.local.get(['port', 'token']).then(
  (stored) => {
    port.value = String(stored['port'] ?? 27484)
    token.value = String(stored['token'] ?? '')
    save.disabled = false
  },
  () => status('E_CLIP_SETTINGS'),
)
field<HTMLFormElement>('settings').addEventListener('submit', (event) => {
  event.preventDefault()
  const number = Number(port.value)
  if (!Number.isInteger(number) || number < 1 || number > 65535 || !token.value.trim()) {
    status('E_CLIP_SETTINGS')
    return
  }
  save.disabled = true
  void chrome.storage.local
    .set({ port: number, token: token.value.trim() })
    .then(
      () => status('settingsSaved'),
      () => status('E_CLIP_SETTINGS'),
    )
    .finally(() => {
      save.disabled = false
    })
})
