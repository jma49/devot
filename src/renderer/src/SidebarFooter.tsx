import { Suspense, lazy, useEffect, useId, useRef, useState } from 'react'
import { BACKUP_FAILED, listBackups } from './backups'
import { footerStatus, type FooterBackups } from './footerStatus'
import { format, t } from './i18n'
import { Chevron } from './Chevron'
import { clockTime, useLastWrite } from './lastWrite'
import { useMirrorStatus } from './mirror'

const StatusPanel = lazy(() => import('./SidebarFooterPanel'))

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
      {open ? (
        <Suspense fallback={null}>
          <StatusPanel id={panelId} onClose={() => setOpen(false)} />
        </Suspense>
      ) : null}
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
