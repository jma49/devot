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

type Phase =
  | { kind: 'prompt' }
  | { kind: 'asking' }
  | { kind: 'review'; proposal: AiProposal }
  | { kind: 'failed'; code: string }

/**
 * Edit with AI: asks the active provider for a rewrite of the selection (a preset at once, a custom instruction once
 * typed), shows it as a diff and applies what the user accepts through the note service, as one undoable edit.
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
        : { kind: 'asking' },
  )
  const [prompt, setPrompt] = useState('')
  const [rejected, setRejected] = useState<ReadonlySet<number>>(new Set())
  const [busy, setBusy] = useState(false)
  // Only the latest request's answer is shown; Cancel or closing drops any other.
  const attempt = useRef(0)
  const locale = currentLocale()

  useLayoutEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
    return () => el?.close()
  }, [])

  const ask = useCallback(
    (what: AiEditAsk) => {
      const mine = ++attempt.current
      setPhase({ kind: 'asking' })
      setRejected(new Set())
      // The notebook as the core has it now: the note may have moved since the list was loaded.
      core
        .read(noteId)
        .then(({ bookId }) => proposeAiEdit(generator, { bookId, selection: start.text }, what))
        .then(
          (proposal) => mine === attempt.current && setPhase({ kind: 'review', proposal }),
          (e: unknown) =>
            mine === attempt.current && setPhase({ kind: 'failed', code: errorCode(e) }),
        )
    },
    [core, generator, noteId, start.text],
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
    attempt.current += 1
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
      setPhase({ kind: 'failed', code: errorCode(e) })
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
          <input
            className="pick-filter"
            type="text"
            aria-label={t('aiEdit.promptLabel')}
            autoComplete="off"
            autoFocus
            maxLength={MAX_AI_PROMPT_CHARS}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (isImeKey(e.nativeEvent)) return
              if (e.key === 'Enter') {
                e.preventDefault()
                send()
              }
            }}
          />
        </label>
      ) : phase.kind === 'asking' ? (
        <p className="sheet-detail" role="status">
          {t('aiEdit.asking')}
        </p>
      ) : failure ? (
        <p role="alert" className="sheet-error">
          {failure.message}
        </p>
      ) : proposal ? (
        <>
          <p className="sheet-detail">{format(t('aiEdit.review'), { model: proposal.model })}</p>
          {changes.length === 0 ? (
            <p className="sheet-detail">{t('aiEdit.noChanges')}</p>
          ) : (
            <section className="ai-edit-diff diff" aria-label={t('aiEdit.changes')}>
              {proposalRows(proposal.parts).map((row, i) =>
                row.kind === 'skipped' ? (
                  <div key={i} className="diff-skipped">
                    {countOf(row.count, locale, 'history.skippedOne', 'history.skippedOther')}
                  </div>
                ) : row.kind === 'take' ? (
                  <label key={i} className="ai-edit-take">
                    <input
                      type="checkbox"
                      checked={!rejected.has(row.part)}
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
            {t('aiEdit.cancel')}
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
