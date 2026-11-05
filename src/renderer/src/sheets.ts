import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { ImportScan } from '../../core'
import { BACKUP_FAILED, SHOW_BACKUPS, errorCode, listBackups, restoreBackup } from './backups'
import type { Core } from './core-client'
import type { ImportChoices, ImportJob } from './ImportDialog'
import { forgetScanFound, setScanFound } from './importProgress'
import {
  IMPORT_FAILED,
  IMPORT_PROGRESS,
  IMPORT_READY,
  IMPORT_SCANNING,
  finishImport,
  runImport,
} from './importer'
import { saveEdits } from './saveGuards'
import type { Selection } from './Sidebar'
import { track } from './usage'
import { listenHere, unlistenLater } from './windowEvents'

/**
 * The main window's sheets: imports, each waiting its turn, and Backups. One shows at a time: no
 * import while Backups is open (a restore replaces the database under it), and Backups waits for
 * an import.
 */
export function useSheets({
  core,
  coreRef,
  refresh,
  showLibraryRef,
}: {
  core: Core | undefined
  coreRef: RefObject<Core | undefined>
  refresh: (c: Core) => Promise<unknown>
  /** Changes view through the latest rules: an import ends by showing its notebook. */
  showLibraryRef: RefObject<
    ((next: Selection, options?: { clearFilter?: boolean }) => void) | undefined
  >
}) {
  const [backupsOpen, setBackupsOpen] = useState(false)
  const [backupNotice, setBackupNotice] = useState<string>()
  const importJobs = useRef<ImportJob[]>([])
  const [importJob, setImportJob] = useState<ImportJob>()
  const [importKey, setImportKey] = useState(0)
  const importShown = useRef(false)
  const backupsShown = useRef(false)
  const backupsWanted = useRef(false)
  // Sessions taken (their scan arrived) or closed: later events for them are ignored.
  const seenImports = useRef(new Set<number>())
  const shownImport = useRef<number | null>(null)

  /** Shows the next sheet unless one is up: an import job first (its result stays until closed; an import ends by showing its notebook), then Backups if asked meanwhile. */
  const nextSheet = useCallback(() => {
    if (importShown.current || backupsShown.current) return
    const c = coreRef.current
    const job = c ? importJobs.current.shift() : undefined
    if (!c || !job) {
      if (backupsWanted.current) {
        backupsWanted.current = false
        backupsShown.current = true
        setBackupsOpen(true)
      }
      return
    }
    importShown.current = true
    shownImport.current = job.id
    setImportKey((k) => k + 1)
    setImportJob(job)
  }, [coreRef])

  const startImport = useCallback(
    async (
      scan: ImportScan,
      destination: string | null,
      progress: (done: number, total: number) => void,
      options: ImportChoices,
    ) => {
      const c = coreRef.current
      if (!c) throw new Error('E_CORE_NOT_READY')
      try {
        await saveEdits(c)
        const started = performance.now()
        const report = await runImport(c, scan, destination, progress, options.wikiLinks)
        track('import.finished', {
          notes: report?.notes ?? 0,
          notebooks: report?.books ?? 0,
          images: report?.attachments ?? 0,
          problems: report?.problems.length ?? scan.skipped.length,
          durationMs: Math.round(performance.now() - started),
        })
        await refresh(c)
        if (report?.bookId) {
          showLibraryRef.current?.({ kind: 'book', id: report.bookId }, { clearFilter: true })
        }
        return report
      } catch (e) {
        console.warn('W_IMPORT_FAILED', errorCode(e))
        await refresh(c).catch(() => {})
        throw new Error(errorCode(e), { cause: e })
      }
    },
    [coreRef, refresh, showLibraryRef],
  )

  const closeImport = (cancelled: boolean) => {
    const id = importJob?.id ?? null
    if (id !== null) forgetScanFound(id)
    if (cancelled && id !== null) {
      seenImports.current.add(id)
      void finishImport(id)
    }
    setImportJob(undefined)
    importShown.current = false
    shownImport.current = null
    nextSheet()
  }

  const showBackups = useCallback(() => {
    backupsWanted.current = true
    nextSheet()
  }, [nextSheet])

  const closeBackups = () => {
    setBackupsOpen(false)
    backupsShown.current = false
    nextSheet()
  }

  useEffect(() => {
    // Rust sends the menu event to this window even while Settings or a
    // native panel has the keyboard; then it must open nothing behind it.
    const show = () => {
      if (document.hasFocus()) showBackups()
    }
    const failed = (e: Event) => setBackupNotice(errorCode((e as CustomEvent).detail))
    window.addEventListener(SHOW_BACKUPS, show)
    window.addEventListener(BACKUP_FAILED, failed)
    listBackups().then(
      (status) => status.lastError && setBackupNotice(status.lastError),
      () => {},
    )
    const unlisten = DEVOT_UI_TEST
      ? undefined
      : unlistenLater(
          Promise.all([
            listenHere('devot://show-backups', () =>
              window.dispatchEvent(new CustomEvent(SHOW_BACKUPS)),
            ),
            listenHere<string>('devot://backup-failed', (e) =>
              window.dispatchEvent(new CustomEvent(BACKUP_FAILED, { detail: e.payload })),
            ),
          ]).then((stops) => () => {
            for (const stop of stops) stop()
          }),
        )
    return () => {
      window.removeEventListener(SHOW_BACKUPS, show)
      window.removeEventListener(BACKUP_FAILED, failed)
      unlisten?.()
    }
  }, [showBackups])

  // Import: Rust reports a scan started and its progress, then what it found (picked files at once) or why it failed. Each import waits its turn; a scan is taken once even if sent twice.
  useEffect(() => {
    const update = (id: number, change: (job: ImportJob) => ImportJob) => {
      if (shownImport.current === id) {
        setImportJob((job) => (job && job.id === id ? change(job) : job))
        return true
      }
      const at = importJobs.current.findIndex((job) => job.id === id)
      if (at === -1) return false
      importJobs.current[at] = change(importJobs.current[at]!)
      return true
    }
    const add = (job: ImportJob) => {
      importJobs.current.push(job)
      nextSheet()
    }
    const scanning = (e: Event) => {
      const { id, name, kind } = (
        e as CustomEvent<Pick<ImportJob, 'name' | 'kind'> & { id: number }>
      ).detail
      if (seenImports.current.has(id) || update(id, (job) => job)) return
      add({ id, name, kind, scan: null, failed: null })
    }
    const progress = (e: Event) => {
      const { id, files, images } = (
        e as CustomEvent<{ id: number; files: number; images: number }>
      ).detail
      if (seenImports.current.has(id)) return
      // Kept out of App state: only the sheet showing it renders again.
      const known = shownImport.current === id || importJobs.current.some((job) => job.id === id)
      if (known) setScanFound(id, { files, images })
    }
    const ready = (e: Event) => {
      const scan = (e as CustomEvent<ImportScan>).detail
      if (seenImports.current.has(scan.id)) return
      seenImports.current.add(scan.id)
      if (update(scan.id, (job) => ({ ...job, scan }))) return
      add({
        id: scan.id,
        name: scan.name,
        kind: scan.kind,
        scan,
        failed: null,
      })
    }
    const failed = (e: Event) => {
      const detail = (e as CustomEvent<{ id: number | null; code: unknown } | string>).detail
      const id = typeof detail === 'object' && detail !== null ? detail.id : null
      const code = errorCode(typeof detail === 'object' && detail !== null ? detail.code : detail)
      if (id !== null) {
        if (seenImports.current.has(id)) return
        seenImports.current.add(id)
        if (update(id, (job) => ({ ...job, failed: code }))) return
      }
      add({
        id,
        name: '',
        kind: 'folder',
        scan: null,
        failed: code,
      })
    }
    window.addEventListener(IMPORT_SCANNING, scanning)
    window.addEventListener(IMPORT_PROGRESS, progress)
    window.addEventListener(IMPORT_READY, ready)
    window.addEventListener(IMPORT_FAILED, failed)
    let stopped = false
    const unlisten: (() => void)[] = []
    if (!DEVOT_UI_TEST) {
      const resend = (from: string, to: string) =>
        listenHere<unknown>(from, (e) =>
          window.dispatchEvent(new CustomEvent(to, { detail: e.payload })),
        )
      void Promise.all([
        resend('devot://import-scanning', IMPORT_SCANNING),
        resend('devot://import-progress', IMPORT_PROGRESS),
        resend('devot://import-ready', IMPORT_READY),
        resend('devot://import-failed', IMPORT_FAILED),
      ]).then((stops) => {
        // Cleaned up before the listeners were ready: stop them now.
        if (stopped) for (const stop of stops) stop()
        else unlisten.push(...stops)
      })
    }
    return () => {
      stopped = true
      window.removeEventListener(IMPORT_SCANNING, scanning)
      window.removeEventListener(IMPORT_PROGRESS, progress)
      window.removeEventListener(IMPORT_READY, ready)
      window.removeEventListener(IMPORT_FAILED, failed)
      for (const stop of unlisten) stop()
    }
  }, [nextSheet])

  const restore = async (id: string) => {
    // No import runs while Backups is open; stopping one is a safeguard.
    await core?.stopImport()
    if (core) await saveEdits(core)
    await restoreBackup(
      id,
      core
        ? {
            hold: () => core.holdCompaction(),
            resume: () => core.resumeCompaction(),
          }
        : undefined,
    )
    // Folders picked meanwhile were never imported: close their sessions.
    for (const job of importJobs.current.splice(0)) {
      if (job.id !== null) {
        forgetScanFound(job.id)
        await finishImport(job.id)
      }
    }
    window.location.reload()
  }

  return {
    importJob,
    importKey,
    backupsOpen,
    backupNotice,
    setBackupNotice,
    nextSheet,
    startImport,
    closeImport,
    showBackups,
    closeBackups,
    restore,
  }
}
