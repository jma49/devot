// A note window (src-tauri/src/note_window.rs): one note, edited on a core of its own beside the main
// window. Its capability (src-tauri/capabilities/note-window.json) grants what its note needs.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { startShortcutSettings } from './commands/shortcutSettings'
import { startCrashReporting } from './crash'
import { editorSettings, startEditorSettings, subscribeEditorSettings } from './editorSettings'
import { resolveLocale, setLocale } from './i18n'
import { watchCompositions } from './ime'
import { invoke } from './ipc'
import { forwardConsole, forwardUncaught, type LogEntry } from './log'
import { startMotion } from './motionPreference'
import { applyMotionScale } from './motionTiming'
import { NoteWindow } from './noteWindow/NoteWindow'
import { followSystemAccent } from './theme/accent'
import { startAppearance } from './theme/appearance'
import './theme/tokens.css'
import './app.css'
import './preview/content.css'
import './noteWindow/noteWindow.css'

const sendLog = (entry: LogEntry) => invoke('log_write', { ...entry })
forwardConsole(console, sendLog)
forwardUncaught(window, sendLog)
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
startAppearance()
startMotion()
applyMotionScale(document.documentElement)
if (!DEVOT_UI_TEST) {
  void followSystemAccent(document.documentElement.style, () => editorSettings().systemAccent)
    .then((refresh) => subscribeEditorSettings(refresh))
    .catch(() => console.warn('W_SYSTEM_ACCENT_FAILED'))
}

const root = document.getElementById('root')
if (!root) throw new Error('E_RENDERER_ROOT_MISSING')

createRoot(root).render(
  <StrictMode>
    <NoteWindow />
  </StrictMode>,
)
