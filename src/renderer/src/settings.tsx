// The Settings window (Devot > Settings...): a toolbar of panes, one shown
// at a time (settings/SettingsWindow.tsx). Each pane is its own component
// under settings/ (the window's title bar already says Settings, so the page
// repeats no heading for it); a pane that needs
// Tauri commands gets them granted to this window only
// (src-tauri/capabilities/settings.json).
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { startShortcutSettings } from './commands/shortcutSettings'
import { editorSettings, startEditorSettings, subscribeEditorSettings } from './editorSettings'
import { followSystemAccent } from './theme/accent'
import { startAppearance } from './theme/appearance'
import { startMotion } from './motionPreference'
import { resolveLocale, setLocale, t } from './i18n'
import { watchCompositions } from './ime'
import { SettingsWindow } from './settings/SettingsWindow'
import './theme/tokens.css'
import './app.css'

setLocale(resolveLocale(navigator.languages))
document.title = t('settings.title')
// Before any key handler: the key that ends a composition is the input method's.
watchCompositions(window)
startEditorSettings()
startAppearance()
startMotion()
startShortcutSettings()
// The same accent as the main window, so "Match System Accent" shows here too.
if (!DEVOT_UI_TEST) {
  void followSystemAccent(document.documentElement.style, () => editorSettings().systemAccent)
    .then((refresh) => subscribeEditorSettings(refresh))
    .catch(() => console.warn('W_SYSTEM_ACCENT_FAILED'))
}

const root = document.getElementById('root')
if (!root) throw new Error('E_RENDERER_ROOT_MISSING')

createRoot(root).render(
  <StrictMode>
    <SettingsWindow />
  </StrictMode>,
)
