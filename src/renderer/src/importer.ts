// Markdown folder import (see src/core/import.ts and src-tauri/src/import.rs).
// File > Import > Markdown Folder... lets Rust pick and scan a folder; the
// scan reaches the page as a Tauri event, which App re-sends as a window
// event (UI tests send it too). The core worker runs the import and reads
// files back through the session's commands.
import { invoke } from './ipc'
import * as Comlink from 'comlink'
import type { ImportReport, ImportScan, ImportSource } from '../../core'
import type { Core } from './core-client'

export const IMPORT_READY = 'devot:import-ready'
export const IMPORT_FAILED = 'devot:import-failed'

/** Ends an import session in Rust; its folder can no longer be read. */
export const finishImport = (id: number) =>
  invoke('import_finish', { id }).then(
    () => undefined,
    () => console.warn('W_IMPORT_FINISH_FAILED', id),
  )

/** Imports a scanned folder; the session is closed whatever happens. */
export async function runImport(
  core: Core,
  scan: ImportScan,
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
    return await core.importMarkdown(scan, Comlink.proxy(source), Comlink.proxy(onProgress))
  } finally {
    await finishImport(scan.id)
  }
}
