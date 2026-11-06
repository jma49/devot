import { useState } from 'react'
import type { ExportReport } from '../../../core'
import { errorCode } from '../backups'
import { useMenuEvent } from '../commands/dispatch'
import type { Core } from '../core-client'
import { changeEditorSettings } from '../editorSettings'
import { ExportNotice, failureOf, type ExportFailure } from '../ExportNotice'
import type { ExportAction } from '../noteMenu'
import { PageSetupDialog, type PageSetup } from '../PageSetupDialog'

const EXPORT_ALL = 'devot:export-all'

/** Export, print and copy, with the page setup they ask for first and the notice a failure shows. */
export function useExport(core: Core | undefined) {
  const [exportNotice, setExportNotice] = useState<{
    failure: ExportFailure
    code: string
    values?: Record<string, string | number>
  }>()
  // Print and Export as PDF ask for the page setup first.
  const [pageSetupFor, setPageSetupFor] = useState<{
    action: 'print' | 'exportPdf'
    id: string
  }>()
  /** Runs an export, print or copy (exporter.ts, loaded on first use); a failure is shown with its code in a notice. */
  const runExport = async (
    failure: ExportFailure,
    run: (exporter: typeof import('../exporter')) => Promise<ExportReport | null | void>,
  ) => {
    if (!core) return
    setExportNotice(undefined)
    try {
      const report = await run(await import('../exporter'))
      const problem = report?.problems[0]
      if (report && problem) {
        console.warn('W_EXPORT_INCOMPLETE', problem.code)
        setExportNotice({
          failure: 'partial',
          code: problem.code,
          values: { written: report.notes, problems: report.problems.length },
        })
      }
    } catch (error) {
      const code = errorCode(error)
      console.warn('W_EXPORT_FAILED', code)
      setExportNotice({ failure, code })
    }
  }
  const exportNote = async (action: ExportAction, id: string) => {
    if (action === 'print' || action === 'exportPdf') setPageSetupFor({ action, id })
    else await runExport(failureOf(action), (exporter) => exporter.runNoteExport(core!, action, id))
  }
  /** Remembers the page setup (Rust lays the page out by it), then prints. */
  const printWith = (setup: PageSetup) => {
    if (!pageSetupFor) return
    const { action, id } = pageSetupFor
    setPageSetupFor(undefined)
    void runExport(failureOf(action), async (exporter) => {
      // Rust lays the page out by the settings it holds: when the setup cannot be saved, printing
      // would use the old one, so the export stops and its notice names the code.
      await changeEditorSettings(setup).catch((e: unknown) => {
        console.warn('W_EDITOR_SETTINGS_SAVE_FAILED', errorCode(e))
        throw e
      })
      await exporter.runNoteExport(core!, action, id)
    })
  }
  const exportBook = (action: 'exportMarkdown' | 'exportHtml', id: string) =>
    runExport('export', (exporter) => exporter.runBookExport(core!, action, id))
  const exportNotes = (action: 'exportMarkdown' | 'exportHtml', ids: readonly string[]) =>
    runExport('export', (exporter) => exporter.runSelectionExport(core!, action, ids))
  const exportAll = (action: 'exportMarkdown' | 'exportHtml') =>
    runExport('export', (exporter) => exporter.runAllExport(core!, action))
  useMenuEvent('devot://export-all', EXPORT_ALL, (kind) => {
    if (kind === 'markdown') void exportAll('exportMarkdown')
    else if (kind === 'html') void exportAll('exportHtml')
  })
  const notice = exportNotice ? (
    <ExportNotice
      failure={exportNotice.failure}
      code={exportNotice.code}
      values={exportNotice.values}
      onDismiss={() => setExportNotice(undefined)}
    />
  ) : null
  const dialog = pageSetupFor ? (
    <PageSetupDialog
      action={pageSetupFor.action}
      onConfirm={printWith}
      onCancel={() => setPageSetupFor(undefined)}
    />
  ) : null
  return { setExportNotice, exportNote, exportNotes, exportBook, exportAll, notice, dialog }
}
