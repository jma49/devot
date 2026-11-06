// What a failure says to the person. Error codes never reach the text: they go to the log, and a
// code with a plain reason worth telling adds that reason after the action's sentence.
import { format, t, type MessageKey } from './i18n'

const REASONS: Readonly<Record<string, MessageKey>> = {
  E_NET_FAILED: 'failure.offline',
  E_SYNC_OFFLINE: 'failure.offline',
  E_SYNC_RELAY_FAILED: 'failure.offline',
  E_AI_NETWORK_FAILED: 'failure.offline',
  E_APP_STORE_NETWORK: 'failure.offline',
  E_APP_STORE_UNREACHABLE: 'failure.offline',
  E_NET_HOST_REFUSED: 'failure.addressRefused',
  E_NET_HTTPS_ONLY: 'failure.addressRefused',
  E_URL_CREDENTIALS_REFUSED: 'failure.addressRefused',
  E_URL_SCHEME_REFUSED: 'failure.addressRefused',
  E_NET_TOO_MANY_REDIRECTS: 'failure.serverRefused',
  E_AI_HTTP: 'failure.serverRefused',
  E_AI_REQUEST_REJECTED: 'failure.serverRefused',
  E_SYNC_TOKEN_REFUSED: 'failure.serverRefused',
  E_AI_PROVIDER_UNAVAILABLE: 'failure.serverUnavailable',
  E_APP_STORE_UPSTREAM: 'failure.serverUnavailable',
  E_APP_STORE_UNAVAILABLE: 'failure.serverUnavailable',
  E_APP_STORE_PRODUCT_UNAVAILABLE: 'failure.serverUnavailable',
}

/** Messages that already advise what to do next: no reason is added after them. */
const GIVES_ADVICE: ReadonlySet<MessageKey> = new Set(['httpApi.notListening'])

/** The plain reason for a code, if Devot can say one: network, time limit, refusal or a service that may recover. */
export function failureReason(code: string): MessageKey | undefined {
  const known = REASONS[code]
  if (known) return known
  if (/_TIME(?:OUT|D_OUT)$/.test(code)) return 'failure.timeout'
  return undefined
}

/** `sentence`, followed by the plain reason for `code` when there is one. */
export function withReason(sentence: string, code: string): string {
  const reason = failureReason(code)
  if (!reason) return sentence
  return `${/[.!?]$/.test(sentence) ? sentence : `${sentence}.`} ${t(reason)}`
}

/** A failure in words: the action's sentence with its other placeholders filled, then any plain reason. */
export function failureText(
  message: MessageKey,
  code: string,
  values: Readonly<Record<string, string>> = {},
): string {
  const text = format(t(message), values)
  return GIVES_ADVICE.has(message) ? text : withReason(text, code)
}

/** Call once when a failure is caught, since its text no longer carries the code: logs it and hands it back. */
export function logFailure(code: string, area = 'W_UI_FAILED'): string {
  console.warn(area, code)
  return code
}

/** A `logFailure` for a failure that is read again and again: logs a code once until it changes or `undefined` clears it. */
export function changeLogger(area: string): (code: string | undefined, key?: string) => void {
  const last = new Map<string, string>()
  return (code, key = '') => {
    if (code === undefined) {
      last.delete(key)
      return
    }
    if (last.get(key) === code) return
    last.set(key, code)
    logFailure(code, area)
  }
}
