// The main window's half of the local HTTP API: Rust checks every request and
// hands its call here as an event (`devot://http-api`), then waits for this
// window's answer (`http_api_done`), so this window's core reads and writes
// the library (src-tauri/src/http_api). Calls run one at a time. After a
// write the window takes it in as a change from outside (externalChanges.ts):
// the open editor merges it without an undo step and the lists reload.
import { errorCode } from '../../core/errors'
import { HTTP_API_WRITES, readHttpApiRequest, type HttpApiCall } from '../../core/httpApi'

export const HTTP_API_EVENT = 'devot://http-api'
/** The answer to a call, as a page event in the UI tests' build, which has no Rust to take it. */
export const HTTP_API_DONE_TEST = 'devot:http-api-done'

export interface HttpApiHost {
  run: (call: HttpApiCall) => Promise<unknown>
  reply: (id: number, result: unknown, error: string | null) => Promise<unknown>
  wrote: () => void
}

/** Takes each event payload; one that is not a request is ignored. Resolves once the queue is empty. */
export function httpApiHost({ run, reply, wrote }: HttpApiHost) {
  let queue: Promise<void> = Promise.resolve()
  return (payload: unknown): Promise<void> => {
    const request = readHttpApiRequest(payload)
    if (!request) return queue
    queue = queue.then(async () => {
      let result: unknown = null
      let error: string | null = null
      try {
        result = await run(request.call)
      } catch (e) {
        error = errorCode(e, 'E_HTTP_API_FAILED')
      }
      if (error === null && HTTP_API_WRITES.includes(request.call.op)) wrote()
      try {
        await reply(request.id, result, error)
      } catch (e) {
        // Rust gave up waiting (the client got a timeout); a write is made all the same.
        console.warn('W_HTTP_API_ANSWER_FAILED', errorCode(e))
      }
    })
    return queue
  }
}
