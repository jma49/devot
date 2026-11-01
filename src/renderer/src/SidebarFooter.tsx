import { useEffect, useId, useRef, useState } from 'react'
import { BACKUP_FAILED, SHOW_BACKUPS, errorCode, listBackups, type BackupStatus } from './backups'
import { footerStatus, type FooterBackups } from './footerStatus'
import { currentLocale, format, t } from './i18n'
import { Chevron } from './Chevron'
import { clockTime, useLastWrite } from './lastWrite'
import { pausedMessage, useMirrorStatus } from './mirror'

const dateTime = (ms: number) =>
  new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(ms)

type Backups =
  | { kind: 'loading' }
  | { kind: 'ready'; status: BackupStatus }
  | { kind: 'failed'; code: string }

function StatusPanel(props: { id: string; onClose: () => void }) {
  const mirror = useMirrorStatus()
  const [backups, setBackups] = useState<Backups>({ kind: 'loading' })
  useEffect(() => {
    let alive = true
    listBackups().then(
      (status) => alive && setBackups({ kind: 'ready', status }),
      (error: unknown) => alive && setBackups({ kind: 'failed', code: errorCode(error) }),
    )
    return () => {
      alive = false
    }
  }, [])

  const last = backups.kind === 'ready' ? backups.status.backups[0] : undefined
  return (
    <div id={props.id} className="footer-panel" role="group" aria-label={t('sidebar.statusLabel')}>
      <p className="footer-line">
        {backups.kind === 'failed'
          ? format(t('generalSettings.backupsFailed'), { code: backups.code })
          : backups.kind === 'loading'
            ? ''
            : last
              ? format(t('sidebar.lastBackup'), { date: dateTime(last.createdAt) })
              : t('backups.empty')}
      </p>
      {backups.kind === 'ready' && backups.status.lastError !== null ? (
        <p className="footer-line footer-error">
          {format(t('backups.autoFailed'), { code: backups.status.lastError })}
        </p>
      ) : null}
      <p className="footer-line">
        {mirror.folder === null
          ? t('mirror.off')
          : mirror.paused !== null
            ? pausedMessage(mirror.paused)
            : format(t('sidebar.mirrorOn'), { folder: mirror.folder })}
      </p>
      <button
        type="button"
        className="button"
        onClick={() => {
          props.onClose()
          window.dispatchEvent(new CustomEvent(SHOW_BACKUPS))
        }}
      >
        {t('backups.show')}
      </button>
    </div>
  )
}

function useFooterBackups(open: boolean): FooterBackups {
  const [backups, setBackups] = useState<FooterBackups>({ kind: 'loading' })
  useEffect(() => {
    if (open) return
    let alive = true
    const read = () =>
      listBackups().then(
        (status) =>
          alive &&
          Array.isArray(status?.backups) &&
          setBackups({ kind: 'ready', count: status.backups.length, lastError: status.lastError }),
        () => alive && setBackups({ kind: 'failed' }),
      )
    void read()
    window.addEventListener(BACKUP_FAILED, read)
    return () => {
      alive = false
      window.removeEventListener(BACKUP_FAILED, read)
    }
  }, [open])
  return backups
}

export function SidebarFooter() {
  const at = useLastWrite()
  const [open, setOpen] = useState(false)
  const status = footerStatus(useFooterBackups(open), useMirrorStatus())
  const panelId = useId()
  const root = useRef<HTMLDivElement>(null)

  // Escape or a press outside closes the panel.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && !root.current?.contains(e.target)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [open])

  return (
    <div ref={root} className="sidebar-footer">
      {open ? <StatusPanel id={panelId} onClose={() => setOpen(false)} /> : null}
      <button
        type="button"
        className="footer-toggle"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={at === null ? undefined : format(t('sidebar.savedAt'), { time: clockTime(at) })}
        onClick={() => setOpen((now) => !now)}
      >
        {status === undefined ? (
          <span className="footer-saved">{t('sidebar.statusLabel')}</span>
        ) : (
          <>
            <span className="footer-dot" data-tone={status.tone} aria-hidden="true" />
            {/* The visible status is part of the name: an aria-label would replace it. */}
            <span className="visually-hidden">{t('sidebar.statusLabel')}: </span>
            <span className="footer-saved">{status.text}</span>
          </>
        )}
        <Chevron open={open} closed="up" />
      </button>
    </div>
  )
}
