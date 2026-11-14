// The Markdown mirror in the main window (see mirror.ts): it starts the core
// worker's passes once the window has restored its view, with the launch
// reconcile a moment later so it never slows the start; follows the setting
// (a full pass when the mirror turns on or its folder or Include Attachments
// change, nothing more once it is off); lets a paused mirror check its
// folder when the window comes to the front; with Bring Back Outside Edits
// on, looks for files changed outside Devot when the window comes to the
// front and every few seconds while it shows; shows the mirror's notices;
// and runs the palette's commands (a folder that is not empty is used only
// once the user agrees).
import * as Comlink from 'comlink'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { errorCode } from './backups'
import type { Core } from './core-client'
import { currentLocale, t, type MessageKey } from './i18n'
import {
  changeMirror,
  keptMessage,
  mirrorHost,
  pausedMessage,
  startMirrorStatus,
  useMirrorStatus,
  type MirrorStatus,
} from './mirror'
import { useMirrorFolderChoice } from './MirrorFolderChoice'
import { failureText, logFailure } from './failure'
import { dbChanged } from './externalChanges'

const LAUNCH_DELAY_MS = 2000
/** A look costs one `stat` per file while nothing changed (Rust remembers each file's stamp). */
const RESCAN_MS = 5000

export interface MarkdownMirror {
  status: MirrorStatus
  choose: () => Promise<void>
  turnOff: () => Promise<void>
  notices: ReactNode[]
  dialog: ReactNode
}

/**
 * The mirror in the main window; `ready` once the window has restored its
 * view (lastState.ts), so the first pass never competes with it.
 */
export function useMarkdownMirror(core: Core | undefined, ready: boolean): MarkdownMirror {
  const status = useMirrorStatus()
  const [started, setStarted] = useState(false)
  const [failure, setFailure] = useState<{
    message: MessageKey
    code: string
  }>()
  const [dismissedPause, setDismissedPause] = useState<string | null>(null)
  const launched = useRef(false)

  useEffect(() => startMirrorStatus(), [])

  useEffect(() => {
    if (!core || !ready || started) return
    let alive = true
    const logMirrorFailure = (code: string) => console.warn('W_MIRROR_FAILED', code)
    const broughtBack = (noteIds: readonly string[]) => window.dispatchEvent(dbChanged(noteIds))
    core
      .startMirror(
        Comlink.proxy(mirrorHost),
        t('note.untitled'),
        Comlink.proxy(logMirrorFailure),
        Comlink.proxy(broughtBack),
      )
      .then(
        () => alive && setStarted(true),
        () => console.warn('W_MIRROR_START_FAILED'),
      )
    return () => {
      alive = false
    }
  }, [core, ready, started])

  // Rust's generation moves when the folder or Include Attachments changes
  // (and when a paused mirror resumes, which reconciles by itself).
  useEffect(() => {
    if (!core || !started) return
    if (status.folder === null) {
      void core.mirrorStop()
      return
    }
    const delay = launched.current ? 0 : LAUNCH_DELAY_MS
    launched.current = true
    const timer = setTimeout(() => void core.mirrorReconcile(status.generation), delay)
    return () => clearTimeout(timer)
  }, [core, started, status.folder, status.generation])

  useEffect(() => {
    if (!core || !started) return
    const wake = () => void core.mirrorWake()
    window.addEventListener('focus', wake)
    return () => window.removeEventListener('focus', wake)
  }, [core, started])

  const readBack = status.folder !== null && status.readBack
  useEffect(() => {
    if (!core || !started || !readBack) return
    const rescan = () => {
      if (document.visibilityState === 'visible') void core.mirrorRescan()
    }
    window.addEventListener('focus', rescan)
    const timer = setInterval(rescan, RESCAN_MS)
    return () => {
      window.removeEventListener('focus', rescan)
      clearInterval(timer)
    }
  }, [core, started, readBack])

  if (status.paused === null && dismissedPause !== null) setDismissedPause(null)

  const chooseFailed = useCallback(
    (code: string) => setFailure({ message: 'mirror.chooseFailed', code }),
    [],
  )
  const folderChoice = useMirrorFolderChoice(chooseFailed)
  const choose = useCallback(async () => {
    setFailure(undefined)
    await folderChoice.choose()
  }, [folderChoice])

  const turnOff = useCallback(async () => {
    setFailure(undefined)
    await changeMirror({ turnOff: true }).then(
      () => undefined,
      (error: unknown) =>
        setFailure({
          message: 'mirror.changeFailed',
          code: logFailure(errorCode(error), 'W_MIRROR_SETTING_FAILED'),
        }),
    )
  }, [])

  const locale = currentLocale()
  const notices: ReactNode[] = []
  if (failure) {
    notices.push(
      <div key="mirror-failure" role="alert" className="notice" data-devot-part="notice">
        <span className="notice-text">{failureText(failure.message, failure.code)}</span>
        <button type="button" className="button" onClick={() => setFailure(undefined)}>
          {t('notice.dismiss')}
        </button>
      </div>,
    )
  }
  if (status.folder !== null && status.paused !== null && status.paused !== dismissedPause) {
    const code = status.paused
    notices.push(
      <div key="mirror-paused" role="alert" className="notice" data-devot-part="notice">
        <span className="notice-text">{pausedMessage(code)}</span>
        <button type="button" className="button" onClick={() => setDismissedPause(code)}>
          {t('notice.dismiss')}
        </button>
      </div>,
    )
  }
  if (status.keptCount > 0) {
    notices.push(
      <div key="mirror-kept" role="alert" className="notice" data-devot-part="notice">
        <span className="notice-text">{keptMessage(status.kept, status.keptCount, locale)}</span>
        <button
          type="button"
          className="button"
          onClick={() =>
            void changeMirror({ dismissKept: true }).catch(() =>
              console.warn('W_MIRROR_DISMISS_FAILED'),
            )
          }
        >
          {t('notice.dismiss')}
        </button>
      </div>,
    )
  }

  return { status, choose, turnOff, notices, dialog: folderChoice.dialog }
}
