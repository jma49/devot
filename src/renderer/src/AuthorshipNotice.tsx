// The review notice above the editor (ADR 0007): when agents changed the open note since the owner
// last looked, it names them and offers Review Changes, which steps through each unseen write's
// places in document order, and an Undo All for each writer.
import { useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import type { ReviewStep } from '../../core/authorship'
import type { AgentWriteSummary } from '../../core/storage'
import { writerKey, writerLabel, writersLabel, type WriterRef } from './authorshipLabels'
import { countOf, fullDate } from './format'
import { currentLocale, format, t } from './i18n'
import type { EditorHandle } from './NoteEditor'

/** The step `by` away from `index`, kept inside the `count` steps there are. */
export const stepFrom = (index: number, by: 1 | -1, count: number): number =>
  Math.max(0, Math.min(count - 1, index + by))

/** Each writer once, newest first, as `unseen` (newest first) names them. */
export function noticeWriters(unseen: readonly AgentWriteSummary[]): WriterRef[] {
  const seen = new Map<string, WriterRef>()
  for (const row of unseen) {
    if (!seen.has(writerKey(row))) seen.set(writerKey(row), { kind: row.kind, name: row.name })
  }
  return [...seen.values()]
}

/**
 * Undo All takes out every write of the writer on the note (ADR 0007), seen ones too, so when it
 * wrote more than the notice counts, its button says how many.
 */
export function undoAllLabel(
  writer: WriterRef,
  unseen: readonly AgentWriteSummary[],
  written: readonly AgentWriteSummary[],
  named: boolean,
): string {
  const key = writerKey(writer)
  const count = (rows: readonly AgentWriteSummary[]) =>
    rows.filter((row) => writerKey(row) === key).length
  const total = count(written)
  const vars = { writer: writerLabel(writer), count: String(total) }
  if (total > count(unseen)) {
    return format(t(named ? 'authorship.undoAllCountBy' : 'authorship.undoAllCount'), vars)
  }
  return named ? format(t('authorship.undoAllBy'), vars) : t('authorship.undoAll')
}

export function AuthorshipNotice(props: {
  /** The open note's unseen writes, newest first. */
  unseen: readonly AgentWriteSummary[]
  /** All of the open note's writes, seen or not. */
  written: readonly AgentWriteSummary[]
  editor: RefObject<EditorHandle | null>
  /** The editor shows (Edit or Split), so Review Changes can select in it. */
  canReview: boolean
  /** Undo All changes the note; off once the trial is over without a licence. */
  editing: boolean
  onUndoAll: (writer: WriterRef) => Promise<void>
  onDismiss: () => void
}) {
  const [step, setStep] = useState<{ index: number; steps: ReviewStep[] }>()
  const [busy, setBusy] = useState(false)
  const nextButton = useRef<HTMLButtonElement>(null)
  const locale = currentLocale()
  const writers = noticeWriters(props.unseen)
  const ids = new Set(props.unseen.map((row) => row.writeId))
  const rowOf = new Map(props.unseen.map((row) => [row.writeId, row]))
  // The control with the keyboard goes away with the review, or with the notice: the editor takes it.
  const endReview = () => {
    setStep(undefined)
    props.editor.current?.focus()
  }

  const show = (index: number) => {
    const steps = props.editor.current?.reviewSteps(ids) ?? []
    const at = Math.min(index, steps.length - 1)
    setStep({ index: Math.max(0, at), steps })
    const shown = steps[at]
    if (shown) props.editor.current?.reveal(shown.from, shown.to)
  }
  // Previous and Next stay focusable at either end (aria-disabled), so the keys keep working there.
  const move = (by: 1 | -1) => {
    if (step) show(stepFrom(step.index, by, step.steps.length))
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (!step || event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') move(1)
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') move(-1)
    else if (event.key === 'Escape') endReview()
    else return
    event.preventDefault()
  }

  const shown = step?.steps[step.index]
  const shownRow = shown ? rowOf.get(shown.writeId) : undefined
  const stepText =
    shown && shownRow
      ? format(t(shown.from === shown.to ? 'authorship.stepDeletion' : 'authorship.step'), {
          index: String(step!.index + 1),
          count: String(step!.steps.length),
          writer: writerLabel(shownRow),
          time: fullDate(shownRow.at, locale),
        })
      : t('authorship.noSteps')

  return (
    <section
      className="authorship-notice"
      aria-label={t('authorship.notice')}
      data-devot-part="authorship-notice"
      onKeyDown={onKeyDown}
    >
      {step ? (
        <>
          <p className="authorship-notice-text" role="status">
            {stepText}
          </p>
          <span className="authorship-notice-actions">
            <button
              type="button"
              className="button"
              aria-keyshortcuts="ArrowUp"
              aria-disabled={!shown || step.index === 0}
              onClick={() => move(-1)}
            >
              {t('authorship.previous')}
            </button>
            <button
              type="button"
              className="button"
              ref={nextButton}
              aria-keyshortcuts="ArrowDown"
              aria-disabled={!shown || step.index >= step.steps.length - 1}
              onClick={() => move(1)}
            >
              {t('authorship.next')}
            </button>
            <button type="button" className="button" onClick={endReview}>
              {t('authorship.done')}
            </button>
          </span>
        </>
      ) : (
        <>
          <p className="authorship-notice-text">
            {format(
              countOf(
                props.unseen.length,
                locale,
                'authorship.changesOne',
                'authorship.changesOther',
              ),
              { writers: writersLabel(writers) },
            )}
          </p>
          <span className="authorship-notice-actions">
            {props.canReview ? (
              <button
                type="button"
                className="button"
                onClick={() => {
                  show(0)
                  queueMicrotask(() => nextButton.current?.focus())
                }}
              >
                {t('authorship.review')}
              </button>
            ) : null}
            {writers.map((writer) => (
              <button
                key={writerKey(writer)}
                type="button"
                className="button"
                disabled={busy || !props.editing}
                onClick={() => {
                  setBusy(true)
                  void props.onUndoAll(writer).finally(() => {
                    setBusy(false)
                    props.editor.current?.focus()
                  })
                }}
              >
                {undoAllLabel(writer, props.unseen, props.written, writers.length > 1)}
              </button>
            ))}
            <button
              type="button"
              className="button"
              onClick={() => {
                props.onDismiss()
                props.editor.current?.focus()
              }}
            >
              {t('authorship.dismiss')}
            </button>
          </span>
        </>
      )}
    </section>
  )
}
