import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  MAX_AI_PROMPT_CHARS,
  proposalText,
  proposeAiEdit,
  type AiEditAsk,
  type AiProposal,
} from '../../core/aiEdit'
import type { AiGenerator } from '../../core/aiProvider'
import { aiEditFailure, proposalRows } from './aiEditView'
import { errorCode } from './backups'
import type { Core } from './core-client'
import { aiChoiceLabel, type AiEditStart } from './editor/aiMenu'
import { countOf } from './format'
import { currentLocale, format, t } from './i18n'
import { isImeKey } from './ime'
import { LICENCE_REQUIRED } from './licence'
import { LicenceButton } from './LicenceLocked'
import { logFailure } from './failure'

/** The instruction field grows with its lines up to its CSS cap, then scrolls. */
function fitToText(field: HTMLTextAreaElement) {
  field.style.height = 'auto'
  field.style.height = `${field.scrollHeight}px`
}

type Phase =
  | { kind: 'prompt' }
  | { kind: 'asking'; streamed: string }
  | { kind: 'review'; proposal: AiProposal }
  | { kind: 'failed'; code: string }

/**
 * Edit with AI: asks the active provider for a rewrite of the selection (a preset at once, a custom instruction once
 * typed), streams the proposal as text arrives, and applies what the user accepts through the note service, as one undoable edit.
 */
export function AiEditSheet(props: {
  core: Core
  generator: AiGenerator
  noteId: string
  start: AiEditStart
  onApply: (update: Uint8Array) => void
  onClose: () => void
  /** AI is not in the licence: the sheet says so and asks nothing. */
  locked?: boolean
}) {
  const { core, generator, noteId, start, locked = false } = props
  const dialog = useRef<HTMLDialogElement>(null)
  const [phase, setPhase] = useState<Phase>(
    locked
      ? { kind: 'failed', code: LICENCE_REQUIRED }
      : start.choice === 'prompt'
        ? { kind: 'prompt' }
        : { kind: 'asking', streamed: '' },
  )
  const [prompt, setPrompt] = useState('')
  const [rejected, setRejected] = useState<ReadonlySet<number>>(new Set())
  const [busy, setBusy] = useState(false)
  // Only the latest request's answer is shown; Discard, Escape, Retry, or unmounting cancels any earlier stream.
  const attempt = useRef(0)
  const activeAbort = useRef<AbortController | null>(null)
  const mounted = useRef(false)
  const locale = currentLocale()

  const cancelActive = useCallback(() => {
    attempt.current += 1
    activeAbort.current?.abort()
    activeAbort.current = null
  }, [])

  useLayoutEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
    return () => el?.close()
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      // Deferred: a dialog still connected on the next microtask was only remounted (StrictMode).
      queueMicrotask(() => {
        if (!mounted.current) cancelActive()
      })
    }
  }, [cancelActive])

  const ask = useCallback(
    (what: AiEditAsk) => {
      cancelActive()
      const mine = attempt.current
      const controller = new AbortController()
      activeAbort.current = controller
      setPhase({ kind: 'asking', streamed: '' })
      setRejected(new Set())
      // The notebook as the core has it now: the note may have moved since the list was loaded.
      core
        .read(noteId)
        .then(({ bookId }) => {
          if (mine !== attempt.current || controller.signal.aborted) {
            throw new Error('E_AI_CANCELLED')
          }
          return proposeAiEdit(generator, { bookId, selection: start.text }, what, {
            onProgress: (chunk) => {
              if (mine !== attempt.current || controller.signal.aborted || chunk === '') return
              setPhase((now) =>
                now.kind === 'asking' ? { kind: 'asking', streamed: now.streamed + chunk } : now,
              )
            },
            signal: controller.signal,
          })
        })
        .then(
          (proposal) => {
            if (mine !== attempt.current) return
            if (activeAbort.current === controller) activeAbort.current = null
            setPhase({ kind: 'review', proposal })
          },
          (e: unknown) => {
            if (mine !== attempt.current) return
            if (activeAbort.current === controller) activeAbort.current = null
            const code = errorCode(e)
            // Only this sheet's own abort is quiet; Rust ending the stream is a failure to show.
            if (code === 'E_AI_CANCELLED' && controller.signal.aborted) return
            setPhase({ kind: 'failed', code: logFailure(code, 'W_AI_EDIT_FAILED') })
          },
        )
    },
    [cancelActive, core, generator, noteId, start.text],
  )
  const again = () => ask(start.choice === 'prompt' ? { prompt } : { preset: start.choice })

  // The pick in the menu was the user's request; asked once (React runs effects twice in development).
  const started = useRef(false)
  useEffect(() => {
    if (started.current || start.choice === 'prompt' || locked) return
    started.current = true
    ask({ preset: start.choice })
  }, [ask, start.choice, locked])

  const close = () => {
    cancelActive()
    props.onClose()
  }

  const accept = async (proposal: AiProposal) => {
    setBusy(true)
    try {
      const update = await core.applyAiEdit(noteId, {
        from: start.from,
        original: proposal.original,
        replacement: proposalText(proposal.parts, rejected),
      })
      props.onApply(update)
      props.onClose()
    } catch (e) {
      setBusy(false)
      setPhase({ kind: 'failed', code: logFailure(errorCode(e), 'W_AI_EDIT_FAILED') })
    }
  }

  const send = () => {
    if (prompt.trim() !== '') ask({ prompt })
  }

  const title =
    start.choice === 'prompt'
      ? t('aiEdit.title')
      : format(t('aiEdit.titlePreset'), { preset: t(aiChoiceLabel(start.choice)) })

  const proposal = phase.kind === 'review' ? phase.proposal : undefined
  const changes = proposal?.parts.flatMap((p, i) => (p.kind === 'change' ? [i] : [])) ?? []
  const taken = changes.filter((i) => !rejected.has(i)).length
  const failure = phase.kind === 'failed' ? aiEditFailure(phase.code) : undefined
  const rows = proposal ? proposalRows(proposal.parts) : []
  // The lines of each change, for a check box to describe the change it takes.
  const changeLines = new Map<number, string[]>()
  rows.forEach((row, i) => {
    if (row.kind === 'removed' || row.kind === 'added') {
      changeLines.set(row.part, [...(changeLines.get(row.part) ?? []), `ai-edit-line-${i}`])
    }
  })

  const diff = useRef<HTMLElement>(null)
  // The Cancel button that had focus unmounts with the proposal; focus the diff so it is read out.
  useEffect(() => {
    if (phase.kind === 'review' && changes.length > 0) diff.current?.focus()
  }, [phase.kind, changes.length])

  return (
    <dialog
      ref={dialog}
      className="sheet ai-edit"
      aria-labelledby="ai-edit-title"
      aria-busy={phase.kind === 'asking' || busy}
      onCancel={(e) => {
        e.preventDefault()
        if (!busy) close()
      }}
      // WebKit stops honouring preventDefault after a few Escapes in a row and closes the dialog itself: reopen it while
      // busy, else tell App.
      onClose={(e) => {
        if (e.target !== e.currentTarget || dialog.current?.open) return
        if (busy) dialog.current?.showModal()
        else close()
      }}
    >
      <h2 id="ai-edit-title" className="sheet-title">
        {title}
      </h2>
      {phase.kind === 'prompt' ? (
        <label className="sheet-field">
          <span className="sheet-detail">{t('aiEdit.promptDetail')}</span>
          <textarea
            className="pick-filter ai-edit-prompt"
            aria-label={t('aiEdit.promptLabel')}
            autoComplete="off"
            autoFocus
            rows={2}
            maxLength={MAX_AI_PROMPT_CHARS}
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value)
              fitToText(e.target)
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || isImeKey(e.nativeEvent)) return
              if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
                e.preventDefault()
                send()
              }
            }}
          />
        </label>
      ) : phase.kind === 'asking' ? (
        <>
          <p className="sheet-detail" role="status">
            {phase.streamed.length > 0 ? t('aiEdit.writing') : t('aiEdit.asking')}
          </p>
          {phase.streamed.length > 0 ? (
            // Text grows many times a second: the status line above says it is writing, and the review that follows is read out.
            <section className="ai-edit-stream" aria-label={t('aiEdit.writing')} aria-live="off">
              {phase.streamed}
            </section>
          ) : null}
        </>
      ) : failure ? (
        <p role="alert" className="sheet-error">
          {failure.message}
        </p>
      ) : proposal ? (
        <>
          <p className="sheet-detail" role="status">
            {format(t('aiEdit.review'), { model: proposal.model })}
          </p>
          {changes.length === 0 ? (
            <p className="sheet-detail">{t('aiEdit.noChanges')}</p>
          ) : (
            <section
              ref={diff}
              className="ai-edit-diff diff"
              aria-label={t('aiEdit.changes')}
              tabIndex={0}
            >
              {rows.map((row, i) =>
                row.kind === 'skipped' ? (
                  <div key={i} className="diff-skipped">
                    {countOf(row.count, locale, 'history.skippedOne', 'history.skippedOther')}
                  </div>
                ) : row.kind === 'take' ? (
                  <label key={i} className="ai-edit-take">
                    <input
                      type="checkbox"
                      checked={!rejected.has(row.part)}
                      aria-label={format(t('aiEdit.takeChangeOf'), {
                        index: String(changes.indexOf(row.part) + 1),
                        count: String(changes.length),
                      })}
                      aria-describedby={changeLines.get(row.part)?.join(' ')}
                      onChange={(e) => {
                        const next = new Set(rejected)
                        if (e.target.checked) next.delete(row.part)
                        else next.add(row.part)
                        setRejected(next)
                      }}
                    />
                    {t('aiEdit.takeChange')}
                  </label>
                ) : (
                  <div
                    key={i}
                    id={`ai-edit-line-${i}`}
                    className={`diff-line diff-${row.kind}`}
                    data-rejected={rejected.has(row.part) || undefined}
                  >
                    <span className="diff-mark" aria-hidden="true">
                      {row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ''}
                    </span>
                    {row.kind === 'added' ? (
                      <ins>{row.text}</ins>
                    ) : row.kind === 'removed' ? (
                      <del>{row.text}</del>
                    ) : (
                      <span>{row.text}</span>
                    )}
                  </div>
                ),
              )}
            </section>
          )}
        </>
      ) : null}
      <div className="confirm-actions">
        {phase.kind === 'prompt' ? (
          <>
            <button type="button" className="button" onClick={close}>
              {t('aiEdit.cancel')}
            </button>
            <button
              type="button"
              className="button button-default"
              disabled={prompt.trim() === ''}
              onClick={send}
            >
              {t('aiEdit.send')}
            </button>
          </>
        ) : phase.kind === 'asking' ? (
          <button type="button" className="button" onClick={close}>
            {t('aiEdit.discard')}
          </button>
        ) : (
          <>
            {phase.kind === 'failed' && phase.code === LICENCE_REQUIRED ? (
              <LicenceButton />
            ) : proposal || failure?.retry ? (
              <button type="button" className="button" disabled={busy} onClick={again}>
                {t('aiEdit.retry')}
              </button>
            ) : null}
            <button type="button" className="button" disabled={busy} onClick={close}>
              {proposal ? t('aiEdit.discard') : t('aiEdit.close')}
            </button>
            {proposal ? (
              <button
                type="button"
                className="button button-default"
                disabled={busy || taken === 0}
                onClick={() => void accept(proposal)}
              >
                {taken < changes.length ? t('aiEdit.acceptSome') : t('aiEdit.accept')}
              </button>
            ) : null}
          </>
        )}
      </div>
    </dialog>
  )
}
