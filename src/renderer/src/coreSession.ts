import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { ListedLibrary, TakenIn } from '../../core'
import { errorCode, onRestoreElsewhere } from './backups'
import { startCore, stopCore, type Core } from './core-client'
import { listenExitCancelled } from './exitCancelled'
import { invoke } from './ipc'
import { resumeMirrorAfterCancelledQuit } from './mirror'
import type { RelayLink } from './noteRelay'
import type { QuitGuard } from './saving'
import { answerAsked, listenCloseAsked, saveEdits } from './saveGuards'
import { welcomeContent } from './welcome/content'
import { listSeeded } from './welcome/seed'

export function useCoreSession() {
  const [core, setCore] = useState<Core>()
  const coreRef = useRef<Core>(undefined)
  const [startFailure, setStartFailure] = useState<string>()
  const [startAttempt, setStartAttempt] = useState(0)
  const [coreFailure, setCoreFailure] = useState<string>()
  const onCoreFailure = useCallback((code: string) => {
    console.error(code)
    setCoreFailure(code)
  }, [])
  const adopt = useCallback((c: Core | undefined) => {
    setCore(() => c)
    coreRef.current = c
  }, [])
  const retryStart = () => {
    setStartFailure(undefined)
    setStartAttempt((n) => n + 1)
  }
  return {
    core,
    coreRef,
    startFailure,
    setStartFailure,
    startAttempt,
    coreFailure,
    setCoreFailure,
    onCoreFailure,
    adopt,
    retryStart,
  }
}

/** Starts the core (again on each retry); the lists load once it has, then the next sheet shows. */
export function useCoreStart(
  { startAttempt, setStartFailure, onCoreFailure, adopt }: ReturnType<typeof useCoreSession>,
  {
    primary,
    lists,
    relay,
    refresh,
    nextSheet,
    onSaveProblems,
    showWrites,
    authorshipChanged,
    takeIn,
    setListsLoaded,
  }: {
    primary: boolean
    lists: { wrote: () => void }
    relay: { link: RelayLink }
    refresh: (c: Core) => Promise<ListedLibrary>
    nextSheet: () => void
    onSaveProblems: Parameters<typeof startCore>[0]
    showWrites: (writes: ReadonlyMap<string, number>) => void
    authorshipChanged: () => void
    takeIn: (change: TakenIn) => void
    setListsLoaded: (loaded: boolean) => void
  },
) {
  useEffect(() => {
    let alive = true
    let started: Core | undefined
    void startCore(onSaveProblems, showWrites, onCoreFailure, {
      lean: !primary,
      onWrote: lists.wrote,
      onAuthored: authorshipChanged,
      onRelay: (message) => relay.link.send(message),
      onTakenIn: takeIn,
    })
      .then(async (c) => {
        started = c
        if (!alive) return stopCore(c)
        adopt(c)
        // The UI tests' libraries start empty, unless a test asks for the first-launch notes.
        const seeds =
          primary &&
          (!DEVOT_UI_TEST || (globalThis as { devotSeedWelcome?: boolean }).devotSeedWelcome)
        await listSeeded(
          () => refresh(c),
          seeds ? () => c.seedWelcome(welcomeContent()) : undefined,
        )
        setListsLoaded(true)
        nextSheet()
      })
      .catch((e: unknown) => {
        if (!alive) return
        // Not an empty library: the window says why it has none.
        if (started) stopCore(started)
        adopt(undefined)
        const code = errorCode(e)
        console.warn('W_CORE_START_FAILED', code)
        setStartFailure(code)
      })
    return () => {
      alive = false
    }
  }, [
    refresh,
    nextSheet,
    onSaveProblems,
    showWrites,
    authorshipChanged,
    onCoreFailure,
    takeIn,
    relay,
    lists,
    primary,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Try Again starts the library again.
    startAttempt,
    adopt,
    setStartFailure,
    setListsLoaded,
  ])
}

/**
 * What Rust asks of the main window before it goes: the quit's save, an idle check, a quit
 * another window called off, and (in a window File > New Window opened) its own close; and a
 * restore in another window, which stops this core.
 */
export function useQuitAndClose({
  core,
  coreRef,
  primary,
  quitGuard,
  closeGuard,
  saveNow,
  markShownSeen,
  setSaveNoticeDismissed,
  setQuitHeld,
  setCloseHeld,
}: {
  core: Core | undefined
  coreRef: RefObject<Core | undefined>
  primary: boolean
  quitGuard: QuitGuard
  closeGuard: QuitGuard
  saveNow: () => void
  markShownSeen: (options?: { reload?: boolean }) => Promise<void>
  setSaveNoticeDismissed: (dismissed: boolean) => void
  setQuitHeld: (held: boolean) => void
  setCloseHeld: (held: boolean) => void
}) {
  useEffect(() => {
    if (!core) return
    // Quitting: Rust holds the exit, asks us to save, and exits on our reply.
    // When a note could not be saved, the first such quit is called off
    // instead: the window stays with the changes and the notice says so
    // (saving.ts); quitting again goes on without them.
    let unlisten: (() => void) | undefined
    let unlistenCancel: (() => void) | undefined
    let unlistenIdle: (() => void) | undefined
    let stopped = false
    if (!DEVOT_UI_TEST) {
      void import('@tauri-apps/api/event').then(async ({ listen }) => {
        const stop = await listen('devot://flush-before-exit', async () => {
          saveNow()
          // A running import stops after the file it is on, so no note
          // is left half made (unless that file outlasts the quit timeout).
          await core.stopImport()
          await answerAsked(
            'quit',
            quitGuard,
            core.flush({ versions: true }),
            () => {
              setQuitHeld(true)
              setSaveNoticeDismissed(false)
            },
            async () => {
              // The notice's writes are seen before the app goes, so they do not come back on the next launch.
              await markShownSeen({ reload: false })
              // A mirror pass ends after the batch it is in, so its manifest
              // lists every file it wrote; the next launch catches up.
              await core.mirrorStop()
              // A large note's last edit may still wait for its pace (Rust's exit timeout bounds this).
              await core.syncFlush()
            },
          )
        })
        if (stopped) stop()
        else unlisten = stop
        // A Devot an AI tool started asks before it quits by itself (background.rs): a save that
        // fails here keeps it running, without the notice a quit's own failure would bring up.
        const stopIdle = await listen('devot://background-idle-check', async () => {
          saveNow()
          const saved = await core.flush({ versions: true }).then(
            () => true,
            () => false,
          )
          await invoke('background_idle_answer', { saved })
        })
        if (stopped) stopIdle()
        else unlistenIdle = stopIdle
      })
      // Another window called the quit off after this one had stopped its mirror: start it again.
      void listenExitCancelled(() => resumeMirrorAfterCancelledQuit(core)).then((stop) => {
        if (stopped) stop()
        else unlistenCancel = stop
      })
    }
    return () => {
      stopped = true
      unlisten?.()
      unlistenCancel?.()
      unlistenIdle?.()
    }
  }, [core, quitGuard, saveNow, markShownSeen, setSaveNoticeDismissed, setQuitHeld])

  // A window File > New Window opened closes after saving, as a note window does (main_windows.rs): Rust holds the close and asks. As for a quit, the first close whose save fails is called off, and the notice says so.
  useEffect(() => {
    if (primary) return
    const closed = () => {
      const ready = coreRef.current
      saveNow()
      void answerAsked(
        'close',
        closeGuard,
        ready?.stopImport().then(() => ready.flush({ versions: true })),
        () => {
          setCloseHeld(true)
          setSaveNoticeDismissed(false)
        },
        // Seen before the window goes, as for a quit.
        () => markShownSeen({ reload: false }),
      )
    }
    return listenCloseAsked(closed)
  }, [primary, coreRef, closeGuard, saveNow, markShownSeen, setSaveNoticeDismissed, setCloseHeld])

  useEffect(
    () =>
      onRestoreElsewhere(async () => {
        if (!core) return
        try {
          await core.stopImport()
          await saveEdits(core)
          // In `main`: no sweep deletes from the restored notes what it chose from these.
          await core.holdCompaction()
        } finally {
          stopCore(core)
        }
      }),
    [core],
  )
}
