// The review notice above the editor (ADR 0007): when agents changed the open note since the owner
// last looked, it names them and offers Review Changes, which steps through each unseen write's
// places in document order with per-step Keep and Undo, and an Undo All for each writer.
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import type { ReviewStep } from '../../core/authorship'
import type { AgentWriteSummary } from '../../core/storage'
import { writerKey, writerLabel, writersLabel, type WriterRef } from './authorshipLabels'
import { countOf, fullDate } from './format'
import { currentLocale, format, t } from './i18n'
import type { EditorHandle } from './editor/handle'

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

/**
 * A review step with a key that stays the same while other steps are kept, undone or edited: its write and its first
 * and last items, so a step that grows (two runs of a write become one) reads as new and is shown again.
 */
interface KeyedStep extends ReviewStep {
  key: string
}

type Phase =
  | { kind: 'idle'; busy: boolean }
  | {
      kind: 'reviewing'
      index: number
      steps: KeyedStep[]
      height: number | undefined
      /** Steps kept one by one while other steps of the same write are still to come. */
      kept: ReadonlySet<string>
      /** Writes kept or undone whole: they leave the review. */
      done: ReadonlySet<string>
      /** Review began in Preview; the editor it selects in is on its way. */
      entering: boolean
      busy: boolean
    }

const IDLE: Phase = { kind: 'idle', busy: false }

const stepKey = (step: ReviewStep) => `${step.writeId}@${step.anchor}..${step.end}`

/** Keys each step by its write and its first and last items, then leaves out kept steps and finished writes. */
export function keyedSteps(
  steps: readonly ReviewStep[],
  kept: ReadonlySet<string>,
  done: ReadonlySet<string>,
): KeyedStep[] {
  return steps
    .filter((step) => !done.has(step.writeId))
    .map((step) => ({ ...step, key: stepKey(step) }))
    .filter((step) => !kept.has(step.key))
}

/**
 * Undo takes back whole writes: the step's write, every place of it, and the later writes that rewrote its text
 * (`group`, newest first); the label says so when that is more than the step shown.
 */
export function undoLabel(group: readonly string[], places: number): string {
  if (group.length > 1) return format(t('authorship.undoGroup'), { count: String(group.length) })
  if (places > 1) return format(t('authorship.undoWhole'), { count: String(places) })
  return t('authorship.undo')
}

export function AuthorshipNotice(props: {
  /** The open note's unseen writes, newest first. */
  unseen: readonly AgentWriteSummary[]
  /** All of the open note's writes, seen or not. */
  written: readonly AgentWriteSummary[]
  editor: RefObject<EditorHandle | null>
  /** The editor shows (Write, Edit or Split), so Review Changes can select in it. */
  canReview: boolean
  /** Undo changes the note; off once the trial is over without a licence. */
  editing: boolean
  /** Review Changes was chosen in Preview: show an editor to review in. */
  onStartReview?: () => void
  /** The review ended: put back the mode it switched from, or focus the editor. */
  onEndReview?: () => void
  /** Keep: marks one write seen. */
  onKeepWrite?: (writeId: string) => Promise<boolean>
  /** Undo: takes out one write as an owner edit; false when it failed. */
  onUndoWrite?: (writeId: string) => Promise<boolean>
  onUndoAll: (writer: WriterRef) => Promise<void>
  onDismiss: () => void
}) {
  const [phase, setPhase] = useState<Phase>(IDLE)
  const section = useRef<HTMLElement>(null)
  const nextButton = useRef<HTMLButtonElement>(null)
  // Bumped when a review ends or the notice goes, so a Keep or Undo answering late changes nothing.
  const generation = useRef(0)
  useEffect(
    () => () => {
      generation.current += 1
    },
    [],
  )
  useEffect(() => {
    if (!props.canReview) generation.current += 1
  }, [props.canReview])
  const locale = currentLocale()
  const writers = noticeWriters(props.unseen)
  const ids = new Set(props.unseen.map((row) => row.writeId))
  const rowOf = new Map(
    [...props.written, ...props.unseen].map((row) => [row.writeId, row] as const),
  )
  const collect = (kept: ReadonlySet<string>, done: ReadonlySet<string>) =>
    keyedSteps(
      props.editor.current?.reviewSteps(new Set([...ids].filter((id) => !done.has(id)))) ?? [],
      kept,
      done,
    )
  // Switching to Preview by hand hides the editor the review selects in, so it ends the review as Done does.
  if (phase.kind === 'reviewing' && !phase.entering && !props.canReview) setPhase(IDLE)

  const endReview = () => {
    generation.current += 1
    setPhase(IDLE)
    // The control with the keyboard goes away with the review: the editor takes it, or Preview comes back.
    if (props.onEndReview) props.onEndReview()
    else props.editor.current?.focus()
  }

  const showAt = (steps: KeyedStep[], index: number) => {
    const shown = steps[index]
    if (shown) props.editor.current?.reveal(shown.from, shown.to)
  }

  // Review chosen in Preview waits for the editor to show before a switch to Preview ends it.
  if (phase.kind === 'reviewing' && phase.entering && props.canReview) {
    setPhase({ ...phase, entering: false })
  }

  const startReview = () => {
    if (phase.kind !== 'idle' || phase.busy) return
    const mine = ++generation.current
    const entering = !props.canReview
    // The editor stays mounted in Preview, so its steps can be read before it shows.
    const steps = collect(new Set(), new Set())
    setPhase({
      kind: 'reviewing',
      index: 0,
      steps,
      height: section.current?.getBoundingClientRect().height,
      kept: new Set(),
      done: new Set(),
      entering,
      busy: false,
    })
    if (!entering) {
      showAt(steps, 0)
      queueMicrotask(() => nextButton.current?.focus())
      return
    }
    props.onStartReview?.()
    // The editor scrolls to the step only once it shows, after the mode's switch.
    requestAnimationFrame(() => {
      if (mine !== generation.current) return
      showAt(steps, 0)
      nextButton.current?.focus()
    })
  }

  const show = (index: number) => {
    if (phase.kind !== 'reviewing' || phase.busy) return
    const steps = collect(phase.kept, phase.done)
    const at = Math.max(0, Math.min(index, steps.length - 1))
    setPhase({ ...phase, index: at, steps })
    showAt(steps, at)
  }

  // Previous and Next stay focusable at either end (aria-disabled), so the keys keep working there.
  const move = (by: 1 | -1) => {
    if (phase.kind === 'reviewing') show(stepFrom(phase.index, by, phase.steps.length))
  }

  /** Moves on after the current step left the review: the next step takes its place, and the review ends after the last. */
  const advance = (
    from: Extract<Phase, { kind: 'reviewing' }>,
    kept: ReadonlySet<string>,
    done: ReadonlySet<string>,
  ) => {
    const steps = collect(kept, done)
    if (steps.length === 0) {
      endReview()
      return
    }
    const at = Math.min(from.index, steps.length - 1)
    setPhase({ ...from, index: at, steps, kept, done, busy: false })
    showAt(steps, at)
  }

  /** Runs `act` for the current step's write; when it succeeds, that write and the others in `leaving` leave the review. */
  const finishWrite = async (
    act: (writeId: string) => Promise<boolean>,
    leaving: readonly string[] = [],
  ) => {
    if (phase.kind !== 'reviewing' || phase.busy) return
    const current = phase.steps[phase.index]
    if (!current) return
    const mine = generation.current
    setPhase({ ...phase, busy: true })
    const ok = await act(current.writeId).catch(() => false)
    if (mine !== generation.current) return
    if (!ok) {
      setPhase({ ...phase, busy: false })
      return
    }
    advance(phase, phase.kept, new Set([...phase.done, current.writeId, ...leaving]))
  }

  const keepCurrent = () => {
    if (phase.kind !== 'reviewing' || phase.busy || !props.onKeepWrite) return
    const current = phase.steps[phase.index]
    if (!current) return
    const keep = props.onKeepWrite
    // A write's last step to be kept marks the write seen; until then only the step leaves the review.
    if (phase.steps.some((step) => step.writeId === current.writeId && step.key !== current.key)) {
      advance(phase, new Set([...phase.kept, current.key]), phase.done)
      return
    }
    void finishWrite(keep)
  }

  const groupOf = (writeId: string) => props.editor.current?.undoGroup(writeId) ?? [writeId]

  const undoCurrent = () => {
    if (!props.editing || !props.onUndoWrite || phase.kind !== 'reviewing') return
    const current = phase.steps[phase.index]
    if (current) void finishWrite(props.onUndoWrite, groupOf(current.writeId))
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (phase.kind !== 'reviewing' || phase.busy || event.metaKey || event.ctrlKey || event.altKey)
      return
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') move(1)
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') move(-1)
    else if (event.key === 'Home') show(0)
    else if (event.key === 'End') show(phase.steps.length - 1)
    else if (event.key === 'k' || event.key === 'K') keepCurrent()
    else if (event.key === 'u' || event.key === 'U') undoCurrent()
    else if (event.key === 'Escape') endReview()
    else return
    event.preventDefault()
  }

  const shown = phase.kind === 'reviewing' ? phase.steps[phase.index] : undefined
  const shownRow = shown ? rowOf.get(shown.writeId) : undefined
  const undoText =
    phase.kind === 'reviewing' && shown
      ? undoLabel(
          groupOf(shown.writeId),
          // Every place of the write as the text is now, kept ones too.
          props.editor.current?.reviewSteps(new Set([shown.writeId])).length ?? 1,
        )
      : t('authorship.undo')
  const stepText =
    phase.kind === 'reviewing' && shown && shownRow
      ? format(t(shown.from === shown.to ? 'authorship.stepDeletion' : 'authorship.step'), {
          index: String(phase.index + 1),
          count: String(phase.steps.length),
          writer: writerLabel(shownRow),
          time: fullDate(shownRow.at, locale),
        })
      : t('authorship.noSteps')

  return (
    <section
      ref={section}
      className="authorship-notice"
      style={
        phase.kind === 'reviewing' && phase.height !== undefined
          ? { minHeight: phase.height }
          : undefined
      }
      aria-label={t('authorship.notice')}
      data-devot-part="authorship-notice"
      onKeyDown={onKeyDown}
    >
      {phase.kind === 'reviewing' ? (
        <>
          <p className="authorship-notice-text" role="status">
            {stepText}
          </p>
          <span className="authorship-notice-actions">
            <button
              type="button"
              className="button"
              aria-keyshortcuts="ArrowUp"
              aria-disabled={!shown || phase.busy || phase.index === 0}
              onClick={() => move(-1)}
            >
              {t('authorship.previous')}
            </button>
            <button
              type="button"
              className="button"
              ref={nextButton}
              aria-keyshortcuts="ArrowDown"
              aria-disabled={!shown || phase.busy || phase.index >= phase.steps.length - 1}
              onClick={() => move(1)}
            >
              {t('authorship.next')}
            </button>
            {props.onKeepWrite ? (
              <button
                type="button"
                className="button"
                aria-keyshortcuts="K"
                aria-disabled={!shown || phase.busy}
                onClick={keepCurrent}
              >
                {t('authorship.keep')}
              </button>
            ) : null}
            {props.onUndoWrite ? (
              <button
                type="button"
                className="button"
                aria-keyshortcuts="U"
                aria-disabled={!shown || phase.busy || !props.editing}
                onClick={undoCurrent}
              >
                {undoText}
              </button>
            ) : null}
            <button type="button" className="button" disabled={phase.busy} onClick={endReview}>
              {t('authorship.done')}
            </button>
          </span>
          {shown && (shown.removed !== undefined || shown.deleted) ? (
            <div
              className="authorship-notice-removed"
              role="region"
              aria-label={t('authorship.removedLabel')}
              data-devot-part="authorship-removed"
            >
              {shown.removed !== undefined ? (
                <del className="authorship-notice-removed-text">{shown.removed}</del>
              ) : (
                <span className="authorship-notice-removed-dropped">
                  {t('authorship.removedDropped')}
                </span>
              )}
            </div>
          ) : null}
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
            {props.canReview || props.onStartReview ? (
              <button type="button" className="button" onClick={startReview}>
                {t('authorship.review')}
              </button>
            ) : null}
            {writers.map((writer) => (
              <button
                key={writerKey(writer)}
                type="button"
                className="button"
                disabled={phase.busy || !props.editing}
                onClick={() => {
                  setPhase({ kind: 'idle', busy: true })
                  const mine = generation.current
                  void props.onUndoAll(writer).finally(() => {
                    if (mine === generation.current) setPhase(IDLE)
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
