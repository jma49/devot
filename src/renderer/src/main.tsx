import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { invoke } from './ipc'
import { App } from './App'
import { isPhoneLayout } from './phone/navigation'
import { resolveLocale, setIPhoneWording, setLocale } from './i18n'
import { watchCompositions } from './ime'
import { startCrashReporting } from './crash'
import { startCore } from './core-client'
import { forwardConsole, forwardUncaught, type LogEntry } from './log'
import { editorSettings, startEditorSettings, subscribeEditorSettings } from './editorSettings'
import { startShortcutSettings } from './commands/shortcutSettings'
import { startSidebarMaterial } from './sidebarMaterial'
import { startSidebarSurround } from './sidebarSurround'
import { followSystemAccent } from './theme/accent'
import { startAppearance } from './theme/appearance'
import { startMotion } from './motionPreference'
import { applyMotionScale } from './motionTiming'
import { watchDialogExits } from './dialogMotion'
import './theme/tokens.css'
import './app.css'
import './preview/content.css'

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
setIPhoneWording(isPhoneLayout(navigator.userAgent))
// Before any key handler: the key that ends a composition is the input method's.
watchCompositions(window)
startEditorSettings()
startShortcutSettings()
startSidebarMaterial()
startAppearance()
startMotion()
applyMotionScale(document.documentElement)
watchDialogExits()
startSidebarSurround()
if (!DEVOT_UI_TEST) {
  void followSystemAccent(document.documentElement.style, () => editorSettings().systemAccent)
    .then((refresh) => subscribeEditorSettings(refresh))
    .catch(() => console.warn('W_SYSTEM_ACCENT_FAILED'))
}

// Tests call these from the page: a bundle, unlike the dev server, has no URL for each module.
if (DEVOT_UI_TEST) {
  Object.assign(globalThis, { devotTestModules: { invoke, startCore, startCrashReporting } })
}

const PhoneApp = lazy(() => import('./phone/PhoneApp').then((m) => ({ default: m.PhoneApp })))

const root = document.getElementById('root')
if (!root) throw new Error('E_RENDERER_ROOT_MISSING')

createRoot(root).render(
  <StrictMode>
    {isPhoneLayout(navigator.userAgent) ? (
      <Suspense>
        <PhoneApp />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
)
