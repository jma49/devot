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
}

/** The plain reason for a code, if Devot can say one: network, time limit, refusal or unavailability. */
export function failureReason(code: string): MessageKey | undefined {
  const known = REASONS[code]
  if (known) return known
  if (/_TIME(?:OUT|D_OUT)$/.test(code)) return 'failure.timeout'
  if (/_UNAVAILABLE$/.test(code)) return 'failure.unavailable'
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
  return withReason(format(t(message), values), code)
}

/** Call once when a failure is caught, since its text no longer carries the code: logs it and hands it back. */
export function logFailure(code: string, area = 'W_UI_FAILED'): string {
  console.warn(area, code)
  return code
}
