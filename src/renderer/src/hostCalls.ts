import { useEffect } from 'react'
import type { DailyNotesSettings } from '../../core'
import { CLI_APPEND_EVENT, cliAppendHost, resolveAppendTarget } from './cliAppend'
import type { Core } from './core-client'
import { errorCode } from './backups'
import { DB_CHANGED } from './externalChanges'
import { HTTP_API_DONE_TEST, HTTP_API_EVENT, httpApiHost } from './httpApiHost'
import { invoke } from './ipc'
import { editingAllowed } from './licence'
import { QUICK_CAPTURE_EVENT, answerCapture, readCaptureRequest } from './quickCaptureHost'
import { track } from './usage'
import { keepListening, listenHere, unlistenLater } from './windowEvents'

/** Quick capture (menu bar mode): this window's core makes the note the capture window sent, and the list shows it. */
export function useQuickCapture(core: Core | undefined, refresh: (c: Core) => Promise<unknown>) {
  useEffect(() => {
    if (!core || DEVOT_UI_TEST) return
    return unlistenLater(
      listenHere<unknown>(QUICK_CAPTURE_EVENT, (e) => {
        const request = readCaptureRequest(e.payload)
        if (!request) return
        void answerCapture(
          request,
          (id) => invoke('quick_capture_claim', { id }),
          async (r) => {
            await core.capture(r.title, r.body, r.bookId)
          },
          (id, error) => invoke('quick_capture_done', { id, error }),
        ).then((saved) => {
          if (!saved) return
          track('note.created', { from: 'quick_capture' })
          void refresh(core)
        })
      }),
    )
  }, [core, refresh])
}

export function useHttpApi(core: Core | undefined) {
  useEffect(() => {
    if (!core) return
    if (DEVOT_UI_TEST) {
      // No Rust in the UI tests' build: a test hands a call in as a page event and hears the answer as another.
      const take = httpApiHost({
        run: (call) => core.httpApi(call),
        reply: async (id, result, error) => {
          window.dispatchEvent(
            new CustomEvent(HTTP_API_DONE_TEST, { detail: { id, result, error } }),
          )
        },
        wrote: () => window.dispatchEvent(new CustomEvent(DB_CHANGED)),
      })
      const onCall = (e: Event) => void take((e as CustomEvent<unknown>).detail)
      window.addEventListener(HTTP_API_EVENT, onCall)
      return () => window.removeEventListener(HTTP_API_EVENT, onCall)
    }
    const take = httpApiHost({
      run: (call) => core.httpApi(call),
      reply: (id, result, error) => invoke('http_api_done', { id, result, error }),
      wrote: () => window.dispatchEvent(new CustomEvent(DB_CHANGED)),
    })
    const listening = keepListening(
      listenHere<unknown>(HTTP_API_EVENT, (e) => void take(e.payload)),
    )
    void listening.ready.then(() => {
      if (listening.stopped()) return
      // Only now does the MCP bridge's socket open, so no call waits on a window still loading.
      invoke('http_api_listening').catch((e: unknown) =>
        console.warn('W_HTTP_API_LISTENING_FAILED', errorCode(e)),
      )
    })
    return listening.stop
  }, [core])
}

/** `devot append` (cliAppend.ts): answered only once the note is saved, so the command's success means the text is on disk. */
export function useCliAppend(
  core: Core | undefined,
  refresh: (c: Core) => Promise<unknown>,
  applyToOpenNote: (noteId: string, update: Uint8Array) => void,
  dailySettings: () => DailyNotesSettings,
) {
  useEffect(() => {
    if (!core || DEVOT_UI_TEST) return
    const take = cliAppendHost({
      run: async (request) => {
        if (!editingAllowed()) throw new Error('E_LICENCE_REQUIRED')
        const id = await resolveAppendTarget(
          request.target,
          () => core.list(),
          async () => (await core.openTodaysNote(dailySettings(), Date.now(), true)).id,
        )
        const update = await core.appendToNote(id, request.text, {
          position: request.position,
          ...(request.heading === null ? {} : { heading: request.heading }),
        })
        applyToOpenNote(id, update)
        await core.flush()
        await refresh(core)
      },
      claim: (id) => invoke('cli_append_claim', { id }),
      reply: (id, error) => invoke('cli_append_done', { id, error }),
    })
    const listening = keepListening(
      listenHere<unknown>(CLI_APPEND_EVENT, (e) => void take(e.payload)),
    )
    // Listening first, then asking for what waits: no request is lost between.
    void listening.ready
      .then(() => (listening.stopped() ? [] : invoke<unknown>('cli_append_take')))
      .then(
        (held) => {
          if (!listening.stopped() && Array.isArray(held)) {
            held.forEach((request) => void take(request))
          }
        },
        (e: unknown) => console.warn('W_CLI_APPEND_TAKE_FAILED', errorCode(e)),
      )
    return listening.stop
  }, [core, refresh, applyToOpenNote, dailySettings])
}
