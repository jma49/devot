import { useLayoutEffect, useRef, useState } from 'react'
import type { AiGenerator } from '../../core/aiProvider'
import {
  MAX_ASK_CHARS,
  answerParts,
  askNotes,
  citedSources,
  type AskAnswer,
  type AskProgress,
  type AskSource,
  type AskStorage,
} from '../../core/askNotes'
import { askFailure } from './aiEditView'
import { errorCode } from './backups'
import { logFailure } from './failure'
import { format, t } from './i18n'
import { isImeKey } from './ime'
import { LICENCE_REQUIRED } from './licence'
import { LicenceButton } from './LicenceLocked'

type Phase =
  | { kind: 'question' }
  | { kind: 'asking'; progress?: AskProgress }
  | { kind: 'answer'; answer: AskAnswer }
  | { kind: 'failed'; code: string }

const titleOf = (source: AskSource) => source.title.trim() || t('askNotes.untitled')

/**
 * Ask Your Notes: a question answered by the active provider from passages of the notes AI may
 * read (core/askNotes.ts), with each cited note a button that opens it. Nothing is sent before
 * Ask, and an answer that comes after Close is dropped.
 */
export function AskNotesSheet(props: {
  storage: AskStorage
  generator: AiGenerator
  onOpen: (noteId: string) => void
  onClose: () => void
  /** AI is not in the licence: the sheet says so and asks nothing. */
  locked?: boolean
}) {
  const { storage, generator, locked = false } = props
  const dialog = useRef<HTMLDialogElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const [phase, setPhase] = useState<Phase>(
    locked ? { kind: 'failed', code: LICENCE_REQUIRED } : { kind: 'question' },
  )
  const [question, setQuestion] = useState('')
  const attempt = useRef(0)

  useLayoutEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
    return () => el?.close()
  }, [])

  const close = () => {
    attempt.current += 1
    props.onClose()
  }

  const ask = () => {
    if (question.trim() === '') return
    const mine = ++attempt.current
    setPhase({ kind: 'asking' })
    const progress = (so: AskProgress) =>
      mine === attempt.current && setPhase({ kind: 'asking', progress: so })
    askNotes(storage, generator, question, progress).then(
      (answer) => mine === attempt.current && setPhase({ kind: 'answer', answer }),
      (e: unknown) =>
        mine === attempt.current &&
        setPhase({ kind: 'failed', code: logFailure(errorCode(e), 'W_ASK_NOTES_FAILED') }),
    )
  }

  const askAnother = () => {
    attempt.current += 1
    setPhase({ kind: 'question' })
    requestAnimationFrame(() => field.current?.select())
  }

  const open = (source: AskSource) => {
    attempt.current += 1
    props.onOpen(source.noteId)
    props.onClose()
  }

  const answer = phase.kind === 'answer' ? phase.answer : undefined
  const streaming = phase.kind === 'asking' ? phase.progress : undefined
  const shown = answer ?? streaming
  const parts = shown ? answerParts(shown.text, shown.sources) : []
  const cited = citedSources(parts)
  const uncited = answer?.sources.filter((s) => !cited.includes(s)) ?? []
  const failure = phase.kind === 'failed' ? askFailure(phase.code) : undefined

  const answerSection = (
    <section
      className="ask-answer"
      aria-label={t('askNotes.answer')}
      aria-busy={phase.kind === 'asking'}
      tabIndex={0}
    >
      {parts.map((part, i) =>
        part.kind === 'text' ? (
          <span key={i}>{part.text}</span>
        ) : (
          <button
            key={i}
            type="button"
            className="ask-cite"
            aria-label={format(t('askNotes.citation'), {
              number: String(part.source.n),
              title: titleOf(part.source),
            })}
            onClick={() => open(part.source)}
          >
            {part.source.n}
          </button>
        ),
      )}
    </section>
  )

  const sourceList = (sources: readonly AskSource[], label: string) =>
    sources.length > 0 ? (
      <section className="ask-sources" aria-label={label}>
        <h3 className="caption">{label}</h3>
        <ul>
          {sources.map((source) => (
            <li key={source.n}>
              <button
                type="button"
                className="ask-source"
                aria-label={format(t('askNotes.openSource'), { title: titleOf(source) })}
                onClick={() => open(source)}
              >
                <span className="ask-number" aria-hidden="true">
                  {source.n}
                </span>
                <span className="ask-source-title">{titleOf(source)}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    ) : null

  return (
    <dialog
      ref={dialog}
      className="sheet ask-notes"
      aria-labelledby="ask-notes-title"
      aria-busy={phase.kind === 'asking'}
      onCancel={(e) => {
        e.preventDefault()
        close()
      }}
      onClose={(e) => {
        if (e.target !== e.currentTarget || dialog.current?.open) return
        close()
      }}
    >
      <h2 id="ask-notes-title" className="sheet-title">
        {t('askNotes.title')}
      </h2>
      {phase.kind === 'question' ? (
        <label className="sheet-field">
          <span className="sheet-detail">{t('askNotes.detail')}</span>
          <textarea
            ref={field}
            className="pick-filter ask-question"
            aria-label={t('askNotes.questionLabel')}
            autoComplete="off"
            autoFocus
            rows={3}
            maxLength={MAX_ASK_CHARS}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (isImeKey(e.nativeEvent)) return
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                ask()
              }
            }}
          />
        </label>
      ) : phase.kind === 'asking' ? (
        <>
          <p className="sheet-detail" role="status">
            {streaming ? t('askNotes.writing') : t('askNotes.asking')}
          </p>
          {streaming ? answerSection : null}
        </>
      ) : failure ? (
        <p role="alert" className="sheet-error">
          {failure.message}
        </p>
      ) : answer ? (
        <>
          <p className="sheet-detail" role="status">
            {format(t('askNotes.answeredBy'), { model: answer.model })}
          </p>
          {answerSection}
          {answer.cutOff ? <p className="sheet-detail">{t('askNotes.cutOff')}</p> : null}
          {sourceList(cited, t('askNotes.sources'))}
          {sourceList(uncited, t('askNotes.uncited'))}
        </>
      ) : null}
      <div className="confirm-actions">
        {phase.kind === 'question' ? (
          <>
            <button type="button" className="button" onClick={close}>
              {t('askNotes.close')}
            </button>
            <button
              type="button"
              className="button button-default"
              disabled={question.trim() === ''}
              onClick={ask}
            >
              {t('askNotes.ask')}
            </button>
          </>
        ) : phase.kind === 'asking' ? (
          <button type="button" className="button" onClick={close}>
            {t('askNotes.close')}
          </button>
        ) : (
          <>
            {phase.kind === 'failed' && phase.code === LICENCE_REQUIRED ? (
              <LicenceButton />
            ) : failure?.retry ? (
              <button type="button" className="button" onClick={ask}>
                {t('askNotes.retry')}
              </button>
            ) : null}
            {!locked ? (
              <button type="button" className="button" onClick={askAnother}>
                {t('askNotes.again')}
              </button>
            ) : null}
            <button type="button" className="button button-default" onClick={close}>
              {t('askNotes.close')}
            </button>
          </>
        )}
      </div>
    </dialog>
  )
}
