import { useEffect, useRef } from 'react'
import type { ImportProblem, ImportReport } from '../../core'
import { countOf, noteCount } from './format'
import { currentLocale, format, t } from './i18n'
import { importReason } from './importReasons'

export type ImportState =
  | { kind: 'running'; name: string; done: number; total: number }
  | { kind: 'done'; name: string; report: ImportReport | null; skipped: ImportProblem[] }
  | { kind: 'failed'; code: string }

function Problems(props: { problems: ImportProblem[] }) {
  if (props.problems.length === 0) return null
  return (
    <>
      <h3 id="import-problems" className="import-problems-title">
        {t('import.problems')}
      </h3>
      <ul className="import-problems" aria-labelledby="import-problems">
        {props.problems.map((p, i) => {
          const reason = importReason(p.code)
          return (
            <li key={`${p.path}:${p.image ?? ''}:${i}`} className="import-problem">
              <span className="import-path">
                {p.path}
                {p.image ? <span className="import-image">{p.image}</span> : null}
              </span>
              <span className="import-reason">
                {reason ? t(reason) : format(t('import.reason.other'), { code: p.code })}
              </span>
            </li>
          )
        })}
      </ul>
    </>
  )
}

/**
 * Progress, then the result of a Markdown folder import. It cannot be
 * closed while the import runs. Give each import its own `key`.
 */
export function ImportDialog(props: { state: ImportState; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const { state } = props
  const locale = currentLocale()
  const running = state.kind === 'running'
  // Closing tells App once, however the sheet was closed.
  const closed = useRef(false)
  const close = () => {
    if (closed.current) return
    closed.current = true
    props.onClose()
  }

  useEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
  }, [])

  let content
  if (state.kind === 'running') {
    content = (
      <>
        <p className="sheet-detail">{format(t('import.running'), { name: state.name })}</p>
        <progress
          className="import-progress"
          aria-label={t('import.progressLabel')}
          max={Math.max(state.total, 1)}
          value={state.done}
        />
        <p className="sheet-detail import-count">
          {format(t('import.progress'), {
            done: new Intl.NumberFormat(locale).format(state.done),
            files: countOf(state.total, locale, 'import.filesOne', 'import.filesOther'),
          })}
        </p>
      </>
    )
  } else if (state.kind === 'failed') {
    const reason = importReason(state.code)
    content = (
      <>
        <p role="alert" className="sheet-error">
          {format(t('import.failed'), { code: state.code })}
        </p>
        {reason ? <p className="sheet-detail">{t(reason)}</p> : null}
      </>
    )
  } else if (state.report === null) {
    content = (
      <>
        <p className="sheet-detail">{format(t('import.empty'), { name: state.name })}</p>
        <Problems problems={state.skipped} />
      </>
    )
  } else {
    const { report } = state
    content = (
      <>
        <p className="sheet-detail import-summary">
          {format(t(report.attachments > 0 ? 'import.summaryWithImages' : 'import.summary'), {
            notes: noteCount(report.notes, locale),
            books: countOf(report.books, locale, 'import.booksOne', 'import.booksOther'),
            images: countOf(report.attachments, locale, 'import.imagesOne', 'import.imagesOther'),
          })}
        </p>
        <Problems problems={report.problems} />
      </>
    )
  }

  return (
    <dialog
      ref={dialog}
      className="sheet import"
      aria-labelledby="import-title"
      aria-busy={running}
      onCancel={(e) => {
        e.preventDefault()
        if (!running) close()
      }}
      // WebKit stops honouring preventDefault after a few Escapes in a row
      // and closes the dialog itself: reopen it while importing.
      onClose={() => {
        if (running) dialog.current?.showModal()
        else close()
      }}
    >
      <h2 id="import-title" className="sheet-title">
        {t('import.title')}
      </h2>
      {content}
      {running ? null : (
        <div className="confirm-actions">
          <button type="button" className="button" onClick={close} autoFocus>
            {t('import.done')}
          </button>
        </div>
      )}
    </dialog>
  )
}
