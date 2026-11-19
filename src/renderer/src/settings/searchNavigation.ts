import { isImeKey, type KeyDownFields } from '../ime'

export function searchKey(event: KeyDownFields, index: number, count: number) {
  if (isImeKey(event)) return
  if (event.key === 'Escape') return { type: 'clear' } as const
  if (count === 0) return
  if (event.key === 'Enter') return { type: 'open', index } as const
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const step = event.key === 'ArrowDown' ? 1 : -1
    return { type: 'select', index: (index + step + count) % count } as const
  }
}

export function focusSetting(body: HTMLElement, label: string, key?: string): boolean {
  const elements = Array.from(body.querySelectorAll<HTMLElement>('*'))
  const stable =
    key === undefined ? undefined : elements.find((element) => element.dataset['setting'] === key)
  const named =
    stable ??
    elements.find((element) => {
      const labelledBy = element
        .getAttribute('aria-labelledby')
        ?.split(/\s+/)
        .map((id) => body.ownerDocument.getElementById(id)?.textContent?.trim() ?? '')
        .join(' ')
      return (
        element.getAttribute('aria-label') === label ||
        labelledBy === label ||
        (element.textContent?.trim() === label &&
          !Array.from(element.children).some((child) => child.textContent?.trim() === label))
      )
    })
  const target =
    stable ??
    (named?.getAttribute('role') === 'radiogroup'
      ? named
      : (named?.closest<HTMLElement>('.setting, .settings-block, section') ?? named))
  if (!target) return false
  target.scrollIntoView({ block: 'center', behavior: 'instant' })
  const control = target.querySelector<HTMLElement>(
    'input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), a[href], [tabindex="0"]',
  )
  if (control) control.focus({ preventScroll: true })
  else focusTemporarily(target)
  return true
}

export function focusTemporarily(target: HTMLElement) {
  const temporary = !target.hasAttribute('tabindex')
  if (temporary) {
    target.tabIndex = -1
    target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true })
  }
  target.focus({ preventScroll: true })
}

export function waitForSetting(
  body: HTMLElement,
  label: string | undefined,
  done: () => void,
  key?: string,
) {
  let phase: 'initial' | 'waiting' | 'stopped' = 'initial'
  let focusing = false
  const transition = (event: 'miss' | 'stop') => {
    phase = event === 'stop' ? 'stopped' : phase === 'initial' ? 'waiting' : phase
  }
  const stop = () => {
    transition('stop')
    observer.disconnect()
    window.clearTimeout(timeout)
    window.removeEventListener('pointerdown', interacted, true)
    window.removeEventListener('keydown', interacted, true)
    window.removeEventListener('focusin', focusChanged, true)
  }
  const finish = () => {
    if (phase === 'stopped') return
    stop()
    done()
  }
  const interacted = () => finish()
  const focusChanged = (event: Event) => {
    if (!focusing && event.target !== body) finish()
  }
  const tryFocus = () => {
    if (phase === 'stopped') return
    focusing = true
    try {
      if (label !== undefined && !focusSetting(body, label, key)) {
        if (phase === 'initial') {
          transition('miss')
          focusTemporarily(body)
        }
        return
      }
      if (label === undefined) focusTemporarily(body)
      finish()
    } finally {
      focusing = false
    }
  }
  const observer = new MutationObserver(tryFocus)
  observer.observe(body, { childList: true, subtree: true, characterData: true })
  const timeout = window.setTimeout(finish, 5000)
  window.addEventListener('pointerdown', interacted, true)
  window.addEventListener('keydown', interacted, true)
  window.addEventListener('focusin', focusChanged, true)
  queueMicrotask(tryFocus)
  return stop
}
