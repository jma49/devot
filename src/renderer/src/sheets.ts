import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { ImportScan } from '../../core'
import { BACKUP_FAILED, SHOW_BACKUPS, errorCode, listBackups, restoreBackup } from './backups'
import type { Core } from './core-client'
import type { ImportJob } from './ImportDialog'
import type { ImportChoices } from './importChoices'
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
  const backupsPhase = useRef<'closed' | 'open' | 'restoring'>('closed')
  const dropWork = useRef<Promise<void>>(Promise.resolve())
  const dropsAllowed = useCallback(() => backupsPhase.current === 'closed', [])
  const runDrop = useCallback(
    (work: () => Promise<void>): Promise<boolean> => {
      if (!dropsAllowed()) return Promise.resolve(false)
      const pending = dropWork.current.then(work)
      dropWork.current = pending.catch(() => {})
      return pending.then(() => true)
    },
    [dropsAllowed],
  )
  const backupsWanted = useRef(false)
  // Sessions taken (their scan arrived) or closed: later events for them are ignored.
  const seenImports = useRef(new Set<number>())
  const shownImport = useRef<number | null>(null)
  const droppedInputs = useRef(new Map<number, NonNullable<Parameters<typeof runImport>[5]>>())
  const cleanupImport = useCallback(async (id: number) => {
    const input = droppedInputs.current.get(id)
    droppedInputs.current.delete(id)
    if (input) await input.cleanup()
    else if (id > 0) await finishImport(id)
  }, [])

  /** Shows the next sheet unless one is up: an import job first (its result stays until closed; an import ends by showing its notebook), then Backups if asked meanwhile. */
  const nextSheet = useCallback(() => {
    if (importShown.current || backupsPhase.current !== 'closed') return
    const c = coreRef.current
    const job = c ? importJobs.current.shift() : undefined
    if (!c || !job) {
      if (backupsWanted.current) {
        backupsWanted.current = false
        backupsPhase.current = 'open'
        setBackupsOpen(true)
      }
      return
    }
    importShown.current = true
    shownImport.current = job.id
    setImportKey((k) => k + 1)
    setImportJob(job)
  }, [coreRef])

  const enqueueImport = useCallback(
    (scan: ImportScan, input?: Parameters<typeof runImport>[5]) => {
      if (seenImports.current.has(scan.id)) return
      seenImports.current.add(scan.id)
      if (input) droppedInputs.current.set(scan.id, input)
      if (shownImport.current === scan.id) {
        setImportJob((job) => (job && job.id === scan.id ? { ...job, scan } : job))
        return
      }
      const queued = importJobs.current.find((job) => job.id === scan.id)
      if (queued) queued.scan = scan
      else
        importJobs.current.push({
          id: scan.id,
          name: scan.name,
          kind: scan.kind,
          scan,
          failed: null,
        })
      nextSheet()
    },
    [nextSheet],
  )

  useEffect(
    () => () => {
      for (const input of droppedInputs.current.values()) void input.cleanup()
      droppedInputs.current.clear()
    },
    [],
  )

  const startImport = useCallback(
    async (
      scan: ImportScan,
      destination: string | null,
      progress: (done: number, total: number) => void,
      options: ImportChoices,
      input?: Parameters<typeof runImport>[5],
    ) => {
      const c = coreRef.current
      if (!c) throw new Error('E_CORE_NOT_READY')
      try {
        await saveEdits(c)
        const started = performance.now()
        const report = await runImport(
          c,
          scan,
          destination,
          progress,
          options,
          input ?? droppedInputs.current.get(scan.id),
        ).finally(() => droppedInputs.current.delete(scan.id))
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
        const dropped = droppedInputs.current.get(scan.id)
        droppedInputs.current.delete(scan.id)
        if (dropped) await dropped.cleanup()
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
    if (id !== null && (cancelled || droppedInputs.current.has(id))) {
      seenImports.current.add(id)
      void cleanupImport(id)
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
    if (backupsPhase.current === 'restoring') return
    setBackupsOpen(false)
    backupsPhase.current = 'closed'
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
          ]),
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
      enqueueImport(scan)
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
    const resend = (from: string, to: string) =>
      listenHere<unknown>(from, (e) =>
        window.dispatchEvent(new CustomEvent(to, { detail: e.payload })),
      )
    const unlisten = DEVOT_UI_TEST
      ? undefined
      : unlistenLater(
          Promise.all([
            resend('devot://import-scanning', IMPORT_SCANNING),
            resend('devot://import-progress', IMPORT_PROGRESS),
            resend('devot://import-ready', IMPORT_READY),
            resend('devot://import-failed', IMPORT_FAILED),
          ]),
        )
    return () => {
      window.removeEventListener(IMPORT_SCANNING, scanning)
      window.removeEventListener(IMPORT_PROGRESS, progress)
      window.removeEventListener(IMPORT_READY, ready)
      window.removeEventListener(IMPORT_FAILED, failed)
      unlisten?.()
    }
  }, [nextSheet, enqueueImport])

  const restore = async (id: string) => {
    backupsPhase.current = 'restoring'
    try {
      await dropWork.current
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
          await cleanupImport(job.id)
        }
      }
      window.location.reload()
    } catch (error) {
      backupsPhase.current = 'open'
      throw error
    }
  }

  return {
    importJob,
    importKey,
    backupsOpen,
    backupNotice,
    setBackupNotice,
    nextSheet,
    startImport,
    enqueueImport,
    dropsAllowed,
    runDrop,
    closeImport,
    showBackups,
    closeBackups,
    restore,
  }
}
