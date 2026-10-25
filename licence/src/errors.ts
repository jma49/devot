export type LicenceCode =
  | 'E_LICENCE_BAD_REQUEST'
  | 'E_LICENCE_CONFIG'
  | 'E_LICENCE_INTERNAL'
  | 'E_LICENCE_MAIL'
  | 'E_LICENCE_METHOD'
  | 'E_LICENCE_NO_CUSTOMER'
  | 'E_LICENCE_NOT_FOUND'
  | 'E_LICENCE_REVOKED'
  | 'E_LICENCE_SESSION_UNKNOWN'
  | 'E_LICENCE_STRIPE'
  | 'E_LICENCE_TOO_LARGE'
  | 'E_LICENCE_UNKNOWN'
  | 'E_LICENCE_UNPAID'
  | 'E_LICENCE_WEBHOOK_SIGNATURE'

/** `detail` is a status or an upstream code, never an address or a key. */
export class LicenceError extends Error {
  readonly code: LicenceCode
  readonly detail: string | undefined

  constructor(code: LicenceCode, detail?: string) {
    super(detail ? `${code} ${detail}` : code)
    this.code = code
    this.detail = detail
  }
}
