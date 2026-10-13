// The Settings window (Devot > Settings...). Each section is its own
// component under settings/, stacked in the window (whose title bar already
// says Settings, so the page repeats no heading for it); a section that needs
// Tauri commands gets them granted to this window only
// (src-tauri/capabilities/settings.json).
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { startShortcutSettings } from './commands/shortcutSettings'
import { startEditorSettings } from './editorSettings'
import { resolveLocale, setLocale, t } from './i18n'
import { watchCompositions } from './ime'
import { AppearanceSection } from './settings/AppearanceSection'
import { EditorSection } from './settings/EditorSection'
import { KeyboardSection } from './settings/KeyboardSection'
import { MirrorSection } from './settings/MirrorSection'
import { UsageSection } from './settings/UsageSection'
import './theme/tokens.css'
import './app.css'

setLocale(resolveLocale(navigator.languages))
document.title = t('settings.title')
// Before any key handler: the key that ends a composition is the input method's.
watchCompositions(window)
startEditorSettings()
startShortcutSettings()

const root = document.getElementById('root')
if (!root) throw new Error('E_RENDERER_ROOT_MISSING')

createRoot(root).render(
  <StrictMode>
    <main className="settings" aria-label={t('settings.title')}>
      <EditorSection />
      <AppearanceSection />
      <KeyboardSection />
      <MirrorSection />
      <UsageSection />
    </main>
  </StrictMode>,
)
