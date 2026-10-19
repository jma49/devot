import { mergeConfig } from 'vite'
import app from './vite.config.ts'

// Only the UI tests use this build: in-memory storage (src/renderer/src/storage/memory.ts), no Tauri.
export default mergeConfig(app, { define: { DEVOT_UI_TEST: 'true' } })
