/**
 * Set at build time (Vite `define`): true only in the UI tests' build
 * (vite.ui-test.config.ts), where notes stay in an in-memory storage
 * (storage/memory.ts) and no Tauri runs behind the page. False in every
 * build of the app, which then leaves that storage out.
 */
declare const DEVOT_UI_TEST: boolean

/**
 * Set at build time (Vite `define`): true when Tauri builds a debug app (`tauri dev`, `tauri build
 * --debug`), whose page then carries the spike harness's probes (phone/screens/spikes.ts). False in
 * a release build, which fails if they are in it (scripts/sentry/ui.ts).
 */
declare const DEVOT_SPIKES: boolean
