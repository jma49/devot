import { useLayoutEffect, useRef } from 'react'
import type { ImportProblem } from '../../../core/import'
import { format, t } from '../i18n'
import { importReason } from '../importReasons'
import { failureText } from '../failure'

export function ImportDetails(props: {
  problems: ImportProblem[]
  onClose: () => void
  onNote: (id: string) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
    return () => el?.close()
  }, [])
  return (
    <dialog
      ref={dialog}
      className="sheet import"
      aria-labelledby="plugin-import-details"
      onCancel={(e) => {
        e.preventDefault()
        props.onClose()
      }}
    >
      <h2 id="plugin-import-details" className="sheet-title">
        {t('plugins.skippedTitle')}
      </h2>
      <ul className="import-problems" aria-label={t('plugins.skippedTitle')}>
        {props.problems.map((problem, index) => {
          const reason = importReason(problem.code)
          return (
            <li className="import-problem" key={index}>
              <span className="import-path">{problem.image ?? t('plugins.skippedContent')}</span>
              <span className="import-reason">
                {reason ? t(reason) : failureText('import.reason.other', problem.code)}
              </span>
              {problem.noteId ? (
                <button
                  type="button"
                  className="button"
                  onClick={() => props.onNote(problem.noteId!)}
                >
                  {format(t('plugins.skippedNote'), { title: problem.noteTitle ?? problem.path })}
                </button>
              ) : (
                <span className="import-path">{problem.noteTitle ?? problem.path}</span>
              )}
            </li>
          )
        })}
      </ul>
      <div className="confirm-actions">
        <button type="button" className="button primary" onClick={props.onClose} autoFocus>
          {t('import.done')}
        </button>
      </div>
    </dialog>
  )
}
