import { useEffect, useId, useRef, useState } from 'react'
import { BACKUP_FAILED, SHOW_BACKUPS, errorCode, listBackups, type BackupStatus } from './backups'
import { closingRef } from './closing'
import { footerStatus, type FooterBackups } from './footerStatus'
import { currentLocale, format, t } from './i18n'
import { Chevron } from './Chevron'
import { Icon } from './icons/Icon'
import { clockTime, useLastWrite } from './lastWrite'
import { pausedMessage, useMirrorStatus } from './mirror'
import { failureText, logFailure } from './failure'

const dateTime = (ms: number) =>
  new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(ms)

const panelRef = closingRef('scale', 'footer-panel')

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
      (error: unknown) =>
        alive &&
        setBackups({ kind: 'failed', code: logFailure(errorCode(error), 'W_BACKUPS_FAILED') }),
    )
    return () => {
      alive = false
    }
  }, [])

  const last = backups.kind === 'ready' ? backups.status.backups[0] : undefined
  const backupTone =
    backups.kind === 'failed' || (backups.kind === 'ready' && backups.status.lastError !== null)
      ? 'error'
      : backups.kind === 'ready' && backups.status.backups.length === 0
        ? 'warn'
        : backups.kind === 'ready'
          ? 'ok'
          : undefined
  const mirrorTone = mirror.folder === null ? undefined : mirror.paused !== null ? 'warn' : 'ok'

  return (
    <div
      ref={panelRef}
      id={props.id}
      className="footer-panel"
      role="group"
      aria-label={t('sidebar.statusLabel')}
    >
      <div className="footer-panel-item">
        <span className="footer-panel-icon" aria-hidden="true">
          <Icon name="history" size="sm" />
        </span>
        <div className="footer-panel-body">
          <div className="footer-panel-head">
            <span className="footer-panel-title">{t('backups.title')}</span>
            {backupTone ? (
              <span className="footer-dot" data-tone={backupTone} aria-hidden="true" />
            ) : null}
          </div>
          <p className={`footer-line${backups.kind === 'failed' ? ' footer-error' : ''}`}>
            {backups.kind === 'failed'
              ? failureText('generalSettings.backupsFailed', backups.code)
              : backups.kind === 'loading'
                ? ''
                : last
                  ? format(t('sidebar.lastBackup'), { date: dateTime(last.createdAt) })
                  : t('backups.empty')}
          </p>
          {backups.kind === 'ready' && backups.status.lastError !== null ? (
            <p className="footer-line footer-error">
              {failureText('backups.autoFailed', backups.status.lastError)}
            </p>
          ) : null}
        </div>
      </div>
      <div className="footer-panel-item">
        <span className="footer-panel-icon" aria-hidden="true">
          <Icon name="settings.mirror" size="sm" />
        </span>
        <div className="footer-panel-body">
          <div className="footer-panel-head">
            <span className="footer-panel-title">{t('mirror.title')}</span>
            {mirrorTone ? (
              <span className="footer-dot" data-tone={mirrorTone} aria-hidden="true" />
            ) : null}
          </div>
          <p className={`footer-line${mirror.paused !== null ? ' footer-warn' : ''}`}>
            {mirror.folder === null
              ? t('mirror.off')
              : mirror.paused !== null
                ? pausedMessage(mirror.paused)
                : mirror.folder}
          </p>
        </div>
      </div>
      <div className="footer-panel-separator" aria-hidden="true" />
      <button
        type="button"
        className="footer-panel-action"
        onClick={() => {
          props.onClose()
          window.dispatchEvent(new CustomEvent(SHOW_BACKUPS))
        }}
      >
        <span className="footer-panel-action-label">{t('backups.show')}</span>
        <span className="footer-panel-action-chevron" aria-hidden="true">
          <Icon name="nav.forward" size="xs" />
        </span>
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
        data-tone={status?.tone}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={at === null ? undefined : format(t('sidebar.savedAt'), { time: clockTime(at) })}
        onClick={() => setOpen((now) => !now)}
      >
        <span className="footer-indicator" aria-hidden="true">
          {status !== undefined ? <span className="footer-dot" data-tone={status.tone} /> : null}
        </span>
        {status === undefined ? (
          <span className="footer-saved">{t('sidebar.statusLabel')}</span>
        ) : (
          <>
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
