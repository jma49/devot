import { extension as chrome } from './platform'

export function message(key: string, values: Record<string, string | number> = {}): string {
  const text = chrome.i18n.getMessage(key) || chrome.i18n.getMessage('E_CLIP_API')
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  )
}

export function localize(): void {
  for (const element of document.querySelectorAll<HTMLElement>('[data-i18n]'))
    element.textContent = chrome.i18n.getMessage(element.dataset['i18n']!)
  for (const element of document.querySelectorAll<HTMLElement>('[data-i18n-label]')) {
    const label = chrome.i18n.getMessage(element.dataset['i18nLabel']!)
    element.setAttribute('aria-label', label)
    element.title = label
  }
  document.documentElement.lang = chrome.i18n.getUILanguage()
}

export function field<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

export function show(element: Element, shown: boolean): void {
  element.toggleAttribute('hidden', !shown)
}
