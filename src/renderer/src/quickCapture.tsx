// The quick capture window (menu bar mode, src-tauri/src/menu_bar.rs): a
// small window that hands its note to the main window's core to save. It
// starts no core of its own; its capability grants only what it needs
// (src-tauri/capabilities/quick-capture.json).
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { editorSettings, startEditorSettings, subscribeEditorSettings } from './editorSettings'
import { followSystemAccent } from './theme/accent'
import { startAppearance } from './theme/appearance'
import { startMotion } from './motionPreference'
import { applyMotionScale } from './motionTiming'
import { resolveLocale, setLocale, t } from './i18n'
import { watchCompositions } from './ime'
import { QuickCapture } from './quickCapture/QuickCapture'
import './theme/tokens.css'
import './app.css'
import './quickCapture/quickCapture.css'

setLocale(resolveLocale(navigator.languages))
document.title = t('quickCapture.windowTitle')
// Before any key handler: the key that ends a composition is the input method's.
watchCompositions(window)
startEditorSettings()
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
    <QuickCapture />
  </StrictMode>,
)
