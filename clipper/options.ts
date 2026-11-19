import type { Request } from './background'
import type { Check, CheckResult } from './setup'
import { field, localize, message, show } from './ui'
import { extension as chrome } from './platform'

const IMAGE_ORIGINS = ['http://*/*', 'https://*/*']
const CHECKS: [Check, string][] = [
  ['connection', 'checkConnection'],
  ['origin', 'checkOrigin'],
  ['token', 'checkToken'],
  ['write', 'checkWrite'],
  ['notebooks', 'checkNotebooks'],
]
const ICONS = {
  passed: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  failed: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  waiting: '<circle cx="12" cy="12" r="10"/>',
}

localize()
const port = field<HTMLInputElement>('port')
const token = field<HTMLInputElement>('token')
const reveal = field<HTMLButtonElement>('reveal')
const save = field<HTMLButtonElement>('save')
const images = field<HTMLButtonElement>('images')
const copy = field<HTMLButtonElement>('copy-origin')
const checks = field<HTMLUListElement>('checks')
const origin = chrome.runtime.getURL('').replace(/\/$/, '')
field<HTMLInputElement>('origin').value = origin

function announce(text: string): void {
  field('status').textContent = text
}

reveal.addEventListener('click', () => {
  const shown = token.type === 'password'
  token.type = shown ? 'text' : 'password'
  reveal.textContent = message(shown ? 'hideToken' : 'showToken')
})

let copyReset: ReturnType<typeof setTimeout> | undefined
copy.addEventListener('click', () => {
  void navigator.clipboard.writeText(origin).then(
    () => {
      copy.textContent = message('copied')
      announce(message('originCopied'))
      clearTimeout(copyReset)
      copyReset = setTimeout(() => {
        copy.textContent = message('copyOrigin')
      }, 2000)
    },
    () => {
      field<HTMLInputElement>('origin').select()
      announce(message('E_CLIP_COPY'))
    },
  )
})

function showImages(granted: boolean, answered = false): void {
  show(images, !granted)
  images.disabled = false
  field('images-state').textContent = granted
    ? message('imagesEnabled')
    : answered
      ? message('imagesRemote')
      : ''
  if (answered) announce(field('images-state').textContent ?? '')
}
void chrome.permissions.contains({ origins: IMAGE_ORIGINS }).then((granted) => showImages(granted))
images.addEventListener('click', () => {
  images.disabled = true
  void chrome.permissions.request({ origins: IMAGE_ORIGINS }).then(
    (granted) => showImages(granted, true),
    () => showImages(false, true),
  )
})

function icon(state: keyof typeof ICONS): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('check-icon', state)
  svg.innerHTML = ICONS[state]
  return svg
}

function showChecks(result: CheckResult): void {
  checks.replaceChildren(
    ...CHECKS.map(([check, label]) => {
      const item = document.createElement('li')
      const state = result.passed.includes(check)
        ? 'passed'
        : result.failed?.check === check
          ? 'failed'
          : 'waiting'
      item.dataset['state'] = state
      const text = document.createElement('span')
      text.textContent =
        check === 'notebooks' && state === 'passed'
          ? message('checkNotebooksCount', { count: result.notebooks })
          : message(label)
      item.append(icon(state), text)
      if (state === 'failed' && result.failed) {
        const fix = document.createElement('p')
        fix.className = 'caption'
        fix.textContent = message(result.failed.code)
        item.append(fix)
      }
      return item
    }),
  )
  if (!result.failed) {
    const done = document.createElement('li')
    done.className = 'connected'
    done.textContent = message('connected')
    checks.append(done)
  }
  show(checks, true)
  announce(result.failed ? message(result.failed.code) : message('connected'))
}

save.disabled = true
void chrome.storage.local.get(['port', 'token']).then(
  (stored) => {
    port.value = String(stored['port'] ?? 27484)
    token.value = String(stored['token'] ?? '')
    save.disabled = false
  },
  () => announce(message('E_CLIP_SETTINGS')),
)

field<HTMLFormElement>('settings').addEventListener('submit', (event) => {
  event.preventDefault()
  const number = Number(port.value)
  if (!Number.isInteger(number) || number < 1 || number > 65535 || !token.value.trim()) {
    showChecks({
      passed: [],
      failed: { check: 'token', code: 'E_CLIP_SETTINGS' },
      notebooks: 0,
    })
    return
  }
  save.disabled = true
  save.textContent = message('checking')
  void chrome.storage.local
    .set({ port: number, token: token.value.trim() })
    .then(() => chrome.runtime.sendMessage({ kind: 'check' } satisfies Request))
    .then((answer: { value?: CheckResult; error?: string } | undefined) => {
      if (!answer?.value) throw new Error(answer?.error ?? 'E_CLIP_API')
      showChecks(answer.value)
    })
    .catch((error: unknown) => {
      showChecks({
        passed: [],
        failed: {
          check: 'connection',
          code: error instanceof Error ? error.message : 'E_CLIP_API',
        },
        notebooks: 0,
      })
    })
    .finally(() => {
      save.disabled = false
      save.textContent = message('check')
    })
})
