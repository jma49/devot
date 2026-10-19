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

export { errorCode } from '../../core/errors'
