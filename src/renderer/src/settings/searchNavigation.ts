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
  let live = true
  const stop = () => {
    live = false
    observer.disconnect()
    window.clearTimeout(timeout)
  }
  const tryFocus = () => {
    if (!live) return
    if (label !== undefined && !focusSetting(body, label, key)) {
      focusTemporarily(body)
      return
    }
    if (label === undefined) focusTemporarily(body)
    stop()
    done()
  }
  const observer = new MutationObserver(tryFocus)
  observer.observe(body, { childList: true, subtree: true, characterData: true })
  const timeout = window.setTimeout(() => {
    stop()
    done()
  }, 5000)
  queueMicrotask(tryFocus)
  return stop
}
