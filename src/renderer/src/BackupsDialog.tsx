import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { backupNow, errorCode, listBackups, type BackupInfo } from './backups'
import { ConfirmDialog } from './ConfirmDialog'
import { fileSize } from './format'
import { currentLocale, format, t } from './i18n'

const backupDate = (ms: number, locale: string) =>
  new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(ms)

/** The local backups, newest first: back up now, or restore one after confirming. */
export function BackupsDialog(props: {
  onRestore: (id: string) => Promise<void>
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const done = useRef<HTMLButtonElement>(null)
  const [backups, setBackups] = useState<BackupInfo[]>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<BackupInfo>()
  const locale = currentLocale()

  const load = useCallback(
    () =>
      listBackups().then(
        (status) => {
          setBackups(status.backups)
          if (status.lastError) setError(status.lastError)
        },
        (e: unknown) => setError(errorCode(e)),
      ),
    [],
  )

  // Opens on Done, so Return dismisses the sheet and never takes a backup.
  // Closing it (not only removing it) gives the keyboard back to what had it.
  useLayoutEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
    done.current?.focus()
    return () => el?.close()
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    try {
      await work()
    } catch (e) {
      setError(errorCode(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialog}
      className="sheet backups"
      aria-labelledby="backups-title"
      onCancel={(e) => {
        e.preventDefault()
        if (!busy) props.onClose()
      }}
      // WebKit stops honouring preventDefault after a few Escapes in a row
      // and closes the dialog itself: reopen it while busy, else tell App.
      onClose={(e) => {
        if (e.target !== e.currentTarget) return
        // Closed by the window going away (see the layout effect): it is gone.
        if (!dialog.current || dialog.current.open) return
        if (busy) dialog.current.showModal()
        else props.onClose()
      }}
    >
      <h2 id="backups-title" className="sheet-title">
        {t('backups.title')}
      </h2>
      <p className="sheet-detail">{t('backups.detail')}</p>
      {error ? (
        <p role="alert" className="sheet-error">
          {format(t('backups.failed'), { code: error })}
        </p>
      ) : null}
      {backups && backups.length === 0 ? (
        <p className="sheet-detail">{t('backups.empty')}</p>
      ) : (
        <ul className="backup-list" aria-labelledby="backups-title">
          {backups?.map((b) => {
            const date = backupDate(b.createdAt, locale)
            return (
              <li key={b.id} className="backup-row">
                <span className="backup-date">{date}</span>
                <span className="backup-size">{fileSize(b.size, locale)}</span>
                <button
                  type="button"
                  className="button"
                  aria-disabled={busy}
                  aria-label={format(t('backups.restoreLabel'), { date })}
                  onClick={() => {
                    if (!busy) setConfirm(b)
                  }}
                >
                  {t('backups.restore')}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <div className="confirm-actions">
        <button
          type="button"
          className="button"
          aria-disabled={busy}
          onClick={() => {
            if (!busy) void run(() => backupNow().then(load))
          }}
        >
          {t('backups.now')}
        </button>
        <button
          type="button"
          className="button"
          aria-disabled={busy}
          ref={done}
          onClick={() => {
            if (!busy) props.onClose()
          }}
        >
          {t('backups.done')}
        </button>
      </div>
      {confirm ? (
        <ConfirmDialog
          message={format(t('backups.confirmRestore'), {
            date: backupDate(confirm.createdAt, locale),
          })}
          detail={t('backups.confirmRestoreDetail')}
          confirm={t('backups.confirm')}
          onConfirm={() => {
            const id = confirm.id
            setConfirm(undefined)
            void run(() => props.onRestore(id))
          }}
          onCancel={() => setConfirm(undefined)}
        />
      ) : null}
    </dialog>
  )
}
