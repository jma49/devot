// Local backups (see src-tauri/src/backups.rs). The menu and the background
// thread reach the page as Tauri events; App re-sends them as these window
// events, which the UI tests can send too.
import { invoke } from './ipc'

export interface BackupInfo {
  id: string
  createdAt: number
  size: number
}

export interface BackupStatus {
  backups: BackupInfo[]
  lastError: string | null
}

export const SHOW_BACKUPS = 'devot:show-backups'
export const BACKUP_FAILED = 'devot:backup-failed'
const RESTORE_PREPARE = 'devot:restore-prepare'
const RESTORE_DONE = 'devot:restore-done'

export const listBackups = () => invoke<BackupStatus>('backups_list')
export const backupNow = () => invoke<BackupInfo>('backup_now')

export interface Compaction {
  hold(): Promise<void>
  resume(): unknown
}

/**
 * Replaces the notes with a backup. Compaction is held first, and the
 * restore waits for a running sweep to finish, so no sweep deletes from the
 * restored database the versions it chose from the old one; when the
 * restore fails, sweeps may start again.
 */
export async function restoreBackup(id: string, compaction?: Compaction) {
  await compaction?.hold()
  try {
    await invoke<null>('backup_restore', { id })
  } catch (error) {
    await compaction?.resume()
    throw error
  }
}

/**
 * Another window restores a backup (backups.rs): `prepare` saves this window's edits and stops its
 * core, so nothing it holds from before the restore is written over it, and Rust hears back even
 * when that fails; once the restore is over, ran or not, the window reloads. The UI tests send
 * these as window events.
 */
export function onRestoreElsewhere(prepare: () => Promise<void>): () => void {
  const prepared = () =>
    void prepare()
      .catch(() => console.warn('W_RESTORE_PREPARE_FAILED'))
      .then(() => invoke('backup_restore_ready'))
      .catch(() => console.warn('W_RESTORE_READY_FAILED'))
  const done = () => window.location.reload()
  window.addEventListener(RESTORE_PREPARE, prepared)
  window.addEventListener(RESTORE_DONE, done)
  let stopped = false
  const stops: (() => void)[] = []
  if (!DEVOT_UI_TEST) {
    void import('./windowEvents')
      .then(({ listenHere }) =>
        Promise.all([
          listenHere('devot://restore-prepare', prepared),
          listenHere('devot://restore-done', done),
        ]),
      )
      .then((own) => {
        if (stopped) own.forEach((stop) => stop())
        else stops.push(...own)
      })
      .catch(() => console.warn('W_RESTORE_LISTEN_FAILED'))
  }
  return () => {
    stopped = true
    window.removeEventListener(RESTORE_PREPARE, prepared)
    window.removeEventListener(RESTORE_DONE, done)
    stops.forEach((stop) => stop())
  }
}

export { errorCode } from '../../core/errors'
