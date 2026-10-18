// Import (see src/core/import.ts and src-tauri/src/import.rs). File > Import
// lets Rust pick folders or files and scan them; the scan's start, progress
// and result (or why it failed) reach the page as Tauri events, which App
// re-sends as window events (UI tests send them too). Once the user presses
// Import, the core worker runs it and reads files back through the
// session's commands.
import { invoke } from './ipc'
import * as Comlink from 'comlink'
import type { ImportReport, ImportScan, ImportSource } from '../../core'
import type { Core } from './core-client'

/** A folder scan started: `{ id, name, kind }`. */
export const IMPORT_SCANNING = 'devot:import-scanning'
/** How far a folder scan has got: `{ id, files, images }`. */
export const IMPORT_PROGRESS = 'devot:import-progress'
/** What a scan found (an `ImportScan`). */
export const IMPORT_READY = 'devot:import-ready'
/** Why a scan failed: `{ id, code }` (`id` null before it had a session). */
export const IMPORT_FAILED = 'devot:import-failed'

/** What a notebook's Import menu can pick (Rust's `Pick`). */
export type ImportPick = 'markdownFiles' | 'markdownFolders' | 'htmlFiles'

/**
 * Opens the panel for `kind`, as File > Import does, with the session's
 * destination set to notebook `bookId`: the sheet then skips choosing one.
 */
export const pickImport = (kind: ImportPick, bookId: string) =>
  invoke('import_pick', { kind, bookId }).then(() => undefined)

/** Ends an import session in Rust; its folder can no longer be read. */
export const finishImport = (id: number) =>
  invoke('import_finish', { id }).then(
    () => undefined,
    () => console.warn('W_IMPORT_FINISH_FAILED', id),
  )

/** Imports a scan into `destination`; the session is closed whatever happens. */
export async function runImport(
  core: Core,
  scan: ImportScan,
  destination: string | null,
  onProgress: (done: number, total: number) => void,
): Promise<ImportReport | null> {
  const source: ImportSource = {
    read: (path) => invoke<string>('import_read', { id: scan.id, path }),
    attach: (path, file) =>
      invoke<null>('import_attach', {
        id: scan.id,
        path,
        fileId: file.id,
        noteId: file.noteId,
      }).then(() => undefined),
  }
  try {
    if (scan.files.length === 0) return null
    return await core.importMarkdown(
      scan,
      destination,
      Comlink.proxy(source),
      Comlink.proxy(onProgress),
    )
  } finally {
    await finishImport(scan.id)
  }
}
