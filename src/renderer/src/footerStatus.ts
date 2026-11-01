import { format, t } from './i18n'

export type FooterBackups =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; count: number; lastError: string | null }

export interface FooterStatus {
  tone: 'ok' | 'warn' | 'error'
  text: string
}

/** The sidebar footer's one-line summary of backups and the Markdown mirror; undefined until the backups are known. */
export function footerStatus(
  backups: FooterBackups,
  mirror: { folder: string | null; paused: string | null },
): FooterStatus | undefined {
  if (backups.kind === 'loading') return undefined
  const failed = backups.kind === 'failed' || backups.lastError !== null
  const none = backups.kind === 'ready' && backups.count === 0
  const paused = mirror.folder !== null && mirror.paused !== null
  const text = format(t('sidebar.footerStatus'), {
    backup: t(failed ? 'sidebar.backupFailed' : none ? 'sidebar.notBackedUp' : 'sidebar.backedUp'),
    mirror: t(
      mirror.folder === null
        ? 'sidebar.mirrorOffShort'
        : paused
          ? 'sidebar.mirrorPausedShort'
          : 'sidebar.mirrorOnShort',
    ),
  })
  return { tone: failed ? 'error' : none || paused ? 'warn' : 'ok', text }
}
