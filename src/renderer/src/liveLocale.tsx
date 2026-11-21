// The language Settings picks shows in every window at once: Rust announces it
// (src-tauri/src/app_language.rs), each window loads that catalog and renders again in place, so
// no note, selection or scroll position is lost. The UI tests' build announces with the page event.
import { type ReactNode, useSyncExternalStore } from 'react'
import {
  currentLocale,
  resolveLocale,
  setLocale,
  shownLanguages,
  subscribeLocale,
  t,
  type MessageKey,
} from './i18n'

const TAURI_EVENT = 'devot://app-language-changed'
const PAGE_EVENT = 'devot:app-language-changed'

function shownIn(detail: unknown): string | undefined {
  if (typeof detail !== 'object' || detail === null) return undefined
  const { shown } = detail as { shown?: unknown }
  return typeof shown === 'string' ? shown : undefined
}

/** Shows the window's language before its first render, then follows each change. */
export async function startLocale(): Promise<void> {
  await setLocale(resolveLocale(shownLanguages()))
  window.addEventListener(PAGE_EVENT, (e) => {
    const shown = shownIn((e as CustomEvent<unknown>).detail)
    if (shown) setLocale(resolveLocale([shown])).catch(() => console.warn('W_LOCALE_LOAD_FAILED'))
  })
  if (DEVOT_UI_TEST) return
  import('@tauri-apps/api/event')
    .then(({ listen }) =>
      listen<unknown>(TAURI_EVENT, (e) =>
        window.dispatchEvent(new CustomEvent(PAGE_EVENT, { detail: e.payload })),
      ),
    )
    .catch(() => console.warn('W_APP_LANGUAGE_LISTEN_FAILED'))
}

/** The active locale, rendering the caller again when it changes. */
export function useLocale(): string {
  return useSyncExternalStore(subscribeLocale, currentLocale, currentLocale)
}

/**
 * Renders `render()` afresh in each language: every component under it renders again, keeping its
 * state; one that skips renders (`memo`) or keeps text it made (`useMemo`) reads `useLocale`.
 */
export function Localised({ render }: { render: () => ReactNode }) {
  useLocale()
  return render()
}

/** The page's title, in each language the window shows. */
export function localiseTitle(key: MessageKey): void {
  document.title = t(key)
  subscribeLocale(() => {
    document.title = t(key)
  })
}
