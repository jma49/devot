import { mergeConfig } from 'vite'
import app from './vite.config.ts'

// The UI tests' build (playwright.config.ts): the app's config, with notes
// kept in an in-memory storage (src/renderer/src/storage/memory.ts) and no
// Tauri behind the page. Only the UI tests use it; the app never does.
export default mergeConfig(app, { define: { DEVOT_UI_TEST: 'true' } })
