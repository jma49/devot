// The Markdown mirror in the main window (see mirror.ts): it starts the core
// worker's passes once the window has restored its view, with the launch
// reconcile a moment later so it never slows the start; follows the setting
// (a full pass when the mirror turns on or its folder or Include Attachments
// change, nothing more once it is off); lets a paused mirror check its
// folder when the window comes to the front; shows the mirror's notices;
// and runs the palette's commands (a folder that is not empty is used only
// once the user agrees).
import * as Comlink from 'comlink'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { errorCode } from './backups'
import type { Core } from './core-client'
import { currentLocale, format, t, type MessageKey } from './i18n'
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

/** The launch reconcile waits this long once the window has restored. */
export const LAUNCH_DELAY_MS = 2000

export interface MarkdownMirror {
  status: MirrorStatus
  /** Shows the folder panel (and asks first when the folder is not empty). */
  choose: () => Promise<void>
  turnOff: () => Promise<void>
  /** The mirror's notices, for the window's notice stack. */
  notices: ReactNode[]
  /** The confirmation for a folder that is not empty, while it is up. */
  dialog: ReactNode
}

/**
 * The mirror in the main window; `ready` once the window has restored its
 * view (lastState.ts), so the first pass never competes with it.
 */
export function useMarkdownMirror(core: Core | undefined, ready: boolean): MarkdownMirror {
  const status = useMirrorStatus()
  const [started, setStarted] = useState(false)
  // What could not be done (a folder used, the mirror turned off), with its code.
  const [failure, setFailure] = useState<{ message: MessageKey; code: string }>()
  // The pause the user dismissed: hidden until another one.
  const [dismissedPause, setDismissedPause] = useState<string | null>(null)
  const launched = useRef(false)

  useEffect(() => startMirrorStatus(), [])

  useEffect(() => {
    if (!core || !ready || started) return
    let alive = true
    const logFailure = (code: string) => console.warn('W_MIRROR_FAILED', code)
    core.startMirror(Comlink.proxy(mirrorHost), t('note.untitled'), Comlink.proxy(logFailure)).then(
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

  // A paused mirror checks its folder again when the window comes to the front.
  useEffect(() => {
    if (!core || !started) return
    const wake = () => void core.mirrorWake()
    window.addEventListener('focus', wake)
    return () => window.removeEventListener('focus', wake)
  }, [core, started])

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
      (error: unknown) => setFailure({ message: 'mirror.changeFailed', code: errorCode(error) }),
    )
  }, [])

  const locale = currentLocale()
  const notices: ReactNode[] = []
  if (failure) {
    notices.push(
      <div key="mirror-failure" role="alert" className="notice" data-devot-part="notice">
        <span className="notice-text">{format(t(failure.message), { code: failure.code })}</span>
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
