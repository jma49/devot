import { errorCode } from '../../../../core/errors'
import { invoke } from '../../ipc'
import { keepListening, listenHere } from '../../windowEvents'
import {
  noticed,
  parseRequest,
  refused,
  replied,
  type ScreensNotice,
  type ScreensReply,
} from './message'
import { SCREENS_HANDLERS, type ScreensHandlers } from './ops'

export const SCREENS_EVENT = 'devot://screens'

export interface ScreensBridge {
  /** Whether the native screens attached; without them the page keeps the web shell. */
  readonly installed: Promise<boolean>
  /** Sends a notice to the native screens; before they are known to be installed, or without them, it is dropped. */
  readonly notify: (notice: ScreensNotice) => void
  /**
   * The page has listed its library, the first-launch notes seeded: Rust sends the links it holds
   * to the native screens from now on, so a link to a first-launch note finds it.
   */
  readonly libraryListed: () => void
  readonly stop: () => void
}

interface Taken {
  readonly installed: boolean
  readonly pending: readonly unknown[]
}

const isTaken = (value: unknown): value is Taken =>
  typeof value === 'object' &&
  value !== null &&
  (value as Taken).installed === true &&
  Array.isArray((value as Taken).pending)

/**
 * Runs the native screens' requests and answers each by its ID. It listens first and only then
 * asks Rust for the requests that came before, so none is lost in between.
 */
export function startScreensBridge(handlers: ScreensHandlers = SCREENS_HANDLERS): ScreensBridge {
  if (DEVOT_UI_TEST)
    return {
      installed: Promise.resolve(false),
      notify: () => {},
      libraryListed: () => {},
      stop: () => {},
    }
  const post = (reply: ScreensReply) =>
    invoke('screens_post', { message: JSON.stringify(reply) }).catch((error: unknown) =>
      console.warn(`W_SCREENS_POST_FAILED id=${reply.id} code=${errorCode(error)}`),
    )
  const run = async (payload: unknown) => {
    const request = parseRequest(payload)
    if (!request) {
      console.warn('W_SCREENS_REQUEST_DROPPED')
      return
    }
    const handler = handlers[request.op]
    if (!handler) {
      await post(refused(request.id, 'E_SCREENS_OP_UNSUPPORTED'))
      return
    }
    let reply: ScreensReply
    try {
      reply = replied(request.id, await handler(request.args))
    } catch (error) {
      const code = errorCode(error, 'E_SCREENS_OP_FAILED')
      console.warn(`W_SCREENS_OP_FAILED op=${request.op} id=${request.id} code=${code}`)
      reply = refused(request.id, code)
    }
    await post(reply)
  }
  let attached = false
  const notify = (notice: ScreensNotice) => {
    if (!attached || listening.stopped()) return
    invoke('screens_post', { message: JSON.stringify(noticed(notice)) }).catch((error: unknown) =>
      console.warn(`W_SCREENS_NOTICE_FAILED notice=${notice.notice} code=${errorCode(error)}`),
    )
  }
  const listening = keepListening(
    listenHere<unknown>(SCREENS_EVENT, (event) => void run(event.payload)),
  )
  const installed = listening.ready
    .then(() => (listening.stopped() ? null : invoke<unknown>('screens_take')))
    .then(
      (taken) => {
        if (listening.stopped() || !isTaken(taken)) {
          listening.stop()
          return false
        }
        attached = true
        for (const request of taken.pending) void run(request)
        return true
      },
      () => {
        console.warn('W_SCREENS_TAKE_FAILED')
        listening.stop()
        return false
      },
    )
  let linksAsked = false
  const libraryListed = () => {
    if (linksAsked) return
    linksAsked = true
    void installed.then((attachedNow) => {
      if (!attachedNow || listening.stopped()) return
      invoke('deep_link_take').catch((error: unknown) =>
        console.warn(`W_DEEP_LINK_TAKE_FAILED code=${errorCode(error)}`),
      )
    })
  }
  return { installed, notify, libraryListed, stop: listening.stop }
}
