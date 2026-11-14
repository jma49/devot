import { useEffect, useLayoutEffect, useReducer, useRef } from 'react'
import { errorCode } from '../../core/errors'
import { writeClipboardText } from './clipboard'
import type { Core } from './core-client'
import { sharedNotePage } from './exporter'
import { fullDate } from './format'
import { currentLocale, format, t, type MessageKey } from './i18n'
import {
  DEFAULT_LIFETIME,
  initialSharePhase,
  LIFETIMES,
  publishShare,
  shareStatus,
  shareStep,
  stopSharing,
  type Lifetime,
  type SharePhase,
  type ShareTask,
} from './shareWeb'

const LIFETIME_LABELS: Readonly<Record<Lifetime, MessageKey>> = {
  1: 'shareWeb.lifetime.day',
  7: 'shareWeb.lifetime.week',
  30: 'shareWeb.lifetime.month',
}

const WORKING: Readonly<Record<ShareTask, MessageKey>> = {
  share: 'shareWeb.sharing',
  update: 'shareWeb.updating',
  stop: 'shareWeb.stopping',
}

/** The sheet's body for a phase, apart from the effects, so each phase renders in a test. */
export function ShareWebBody(props: {
  phase: SharePhase
  onLifetime: (lifetime: Lifetime) => void
  onRun: (task: ShareTask) => void
  onCopy: () => void
  onClose: () => void
}) {
  const { phase } = props
  const locale = currentLocale()
  const shared = phase.kind === 'shared' || phase.kind === 'working' ? (phase.shared ?? null) : null
  const working = phase.kind === 'working' || phase.kind === 'loading'
  const error = phase.kind === 'shared' || phase.kind === 'unshared' ? phase.error : null
  return (
    <>
      <h2 id="share-web-title" className="sheet-title">
        {t('shareWeb.title')}
      </h2>
      {shared ? (
        <>
          <p className="sheet-detail">
            {format(t('shareWeb.sharedDetail'), {
              date: fullDate(shared.expiresAt, locale),
            })}
          </p>
          <input
            className="pick-filter share-web-link"
            type="text"
            readOnly
            aria-label={t('shareWeb.linkLabel')}
            value={shared.url}
            onFocus={(e) => e.currentTarget.select()}
          />
        </>
      ) : (
        <>
          <p className="sheet-detail">{t('shareWeb.warning')}</p>
          <label className="share-web-choice">
            <span className="sheet-detail">{t('shareWeb.lifetimeLabel')}</span>
            <select
              value={
                phase.kind === 'unshared' || phase.kind === 'working'
                  ? phase.lifetime
                  : DEFAULT_LIFETIME
              }
              disabled={working}
              onChange={(e) => props.onLifetime(Number(e.target.value) as Lifetime)}
            >
              {LIFETIMES.map((days) => (
                <option key={days} value={days}>
                  {t(LIFETIME_LABELS[days])}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <p className="sheet-detail share-web-status" role="status">
        {phase.kind === 'working'
          ? t(WORKING[phase.task])
          : phase.kind === 'shared' && phase.copied
            ? t('shareWeb.copied')
            : ''}
      </p>
      {error ? (
        <p className="sheet-error" role="alert">
          {t(error)}
        </p>
      ) : null}
      <div className="confirm-actions">
        {shared ? (
          <>
            <button
              type="button"
              className="button share-web-stop"
              disabled={working}
              onClick={() => props.onRun('stop')}
            >
              {t('shareWeb.stop')}
            </button>
            <button
              type="button"
              className="button"
              disabled={working}
              onClick={() => props.onRun('update')}
            >
              {t('shareWeb.update')}
            </button>
            <button type="button" className="button" onClick={props.onClose}>
              {t('shareWeb.done')}
            </button>
            <button
              type="button"
              className="button button-default"
              disabled={working}
              onClick={props.onCopy}
            >
              {t('shareWeb.copy')}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="button" onClick={props.onClose}>
              {t('dialog.cancel')}
            </button>
            <button
              type="button"
              className="button button-default"
              disabled={working}
              onClick={() => props.onRun('share')}
            >
              {t('shareWeb.share')}
            </button>
          </>
        )}
      </div>
    </>
  )
}

/** Share on Web… for one note: share it, copy its link, update or stop sharing it. */
export function ShareWebSheet(props: { core: Core; noteId: string; onClose: () => void }) {
  const { core, noteId, onClose } = props
  const dialog = useRef<HTMLDialogElement>(null)
  const requests = useRef(0)
  const [phase, dispatch] = useReducer(shareStep, 0, initialSharePhase)

  useLayoutEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
    return () => el?.close()
  }, [])

  useEffect(() => {
    const request = ++requests.current
    dispatch({ kind: 'load', request })
    shareStatus(noteId).then(
      (shared) => dispatch({ kind: 'status', request, shared }),
      (error: unknown) => dispatch({ kind: 'statusFailed', request, code: errorCode(error) }),
    )
    const asked = requests
    return () => {
      asked.current++
    }
  }, [noteId])

  const run = (task: ShareTask) => {
    const request = ++requests.current
    dispatch({ kind: 'start', request, task })
    const lifetime = phase.kind === 'unshared' ? phase.lifetime : DEFAULT_LIFETIME
    const work =
      task === 'stop'
        ? stopSharing(noteId).then(() => null)
        : sharedNotePage(core, noteId).then((page) => publishShare(noteId, page, lifetime))
    work.then(
      (shared) => dispatch({ kind: 'done', request, shared }),
      (error: unknown) => dispatch({ kind: 'failed', request, code: errorCode(error) }),
    )
  }

  const copy = () => {
    if (phase.kind !== 'shared') return
    writeClipboardText(phase.shared.url).then(
      () => dispatch({ kind: 'copied' }),
      () => console.warn('W_SHARE_COPY_FAILED', noteId),
    )
  }

  return (
    <dialog
      ref={dialog}
      className="sheet share-web"
      aria-labelledby="share-web-title"
      aria-busy={phase.kind === 'loading' || phase.kind === 'working'}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <ShareWebBody
        phase={phase}
        onLifetime={(lifetime) => dispatch({ kind: 'lifetime', lifetime })}
        onRun={run}
        onCopy={copy}
        onClose={onClose}
      />
    </dialog>
  )
}
