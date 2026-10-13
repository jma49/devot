/**
 * Set at build time (Vite `define`): true only in the UI tests' build
 * (vite.ui-test.config.ts), where notes stay in an in-memory storage
 * (storage/memory.ts) and no Tauri runs behind the page. False in every
 * build of the app, which then leaves that storage out.
 */
declare const DEVOT_UI_TEST: boolean
