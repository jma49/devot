import { extension as chrome } from './platform'

export function localize(): void {
  for (const element of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    element.textContent = chrome.i18n.getMessage(element.dataset['i18n']!)
  }
  document.documentElement.lang = chrome.i18n.getUILanguage()
}

export function field<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

export function status(code: string): void {
  field('status').textContent = chrome.i18n.getMessage(code) || chrome.i18n.getMessage('E_CLIP_API')
}
