import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { invoke } from './ipc'
import { App } from './App'
import { resolveLocale, setLocale } from './i18n'
import { watchCompositions } from './ime'
import { startCrashReporting } from './crash'
import { forwardConsole, forwardUncaught, type LogEntry } from './log'
import { editorSettings, startEditorSettings, subscribeEditorSettings } from './editorSettings'
import { startShortcutSettings } from './commands/shortcutSettings'
import { startSidebarMaterial } from './sidebarMaterial'
import { followSystemAccent } from './theme/accent'
import { startAppearance } from './theme/appearance'
import './theme/tokens.css'
import './app.css'
import './preview/content.css'

// Coded warnings and errors also go to the local log.
const sendLog = (entry: LogEntry) => invoke('log_write', { ...entry })
forwardConsole(console, sendLog)
forwardUncaught(window, sendLog)
// Crash reporting only in builds made with a DSN; the release matches Rust's.
const sentryDsn = import.meta.env['DEVOT_SENTRY_DSN'] as string | undefined
if (sentryDsn) {
  void import('@tauri-apps/api/app')
    .then(({ getVersion }) => getVersion())
    .then((version) => startCrashReporting(sentryDsn, `devot@${version}`))
    .catch(() => console.warn('W_CRASH_REPORTING_START_FAILED'))
}

setLocale(resolveLocale(navigator.languages))
// Before any key handler: the key that ends a composition is the input method's.
watchCompositions(window)
startEditorSettings()
startShortcutSettings()
startSidebarMaterial()
startAppearance()
if (!DEVOT_UI_TEST) {
  void followSystemAccent(document.documentElement.style, () => editorSettings().systemAccent)
    .then((refresh) => subscribeEditorSettings(refresh))
    .catch(() => console.warn('W_SYSTEM_ACCENT_FAILED'))
}

const root = document.getElementById('root')
if (!root) throw new Error('E_RENDERER_ROOT_MISSING')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
