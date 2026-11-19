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

export function focusSetting(body: HTMLElement, label: string): boolean {
  const named = Array.from(body.querySelectorAll<HTMLElement>('*')).find(
    (element) =>
      element.textContent?.trim() === label &&
      !Array.from(element.children).some((child) => child.textContent?.trim() === label),
  )
  const target = named?.closest<HTMLElement>('.setting, .settings-block, section') ?? named
  if (!target) return false
  target.scrollIntoView({ block: 'center', behavior: 'instant' })
  const control = target.querySelector<HTMLElement>(
    'input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), a[href], [tabindex="0"]',
  )
  if (control) control.focus({ preventScroll: true })
  else {
    target.tabIndex = -1
    target.focus({ preventScroll: true })
  }
  return true
}
