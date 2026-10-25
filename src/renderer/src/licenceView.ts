// What the windows say about the licence: why a key was refused, the state in a sentence, what a
// locked feature needs, and what a devot://licence link would change.
import type { LicenceState } from '../../core/entitlements'
import { format, t, type MessageKey } from './i18n'
import type { LicenceSnapshot } from './licence'

const REASONS: Readonly<Record<string, MessageKey>> = {
  E_LICENCE_MALFORMED: 'licence.reason.malformed',
  E_LICENCE_UNKNOWN_KID: 'licence.reason.unknownKid',
  E_LICENCE_SIGNATURE: 'licence.reason.signature',
  E_LICENCE_KEYCHAIN: 'licence.reason.keychain',
  E_LICENCE_KEYCHAIN_UNAVAILABLE: 'licence.reason.keychain',
}

export function licenceProblem(code: string): string {
  return format(t('licence.problem'), { reason: t(REASONS[code] ?? 'licence.reason.other'), code })
}

/** `updatesUntil` is a UTC date; it is shown as that day wherever the device is. */
export function licenceDate(date: string, locale: string): string {
  const [y, m, d] = date.split('-').map(Number)
  if (y === undefined || m === undefined || d === undefined) return date
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(
    Date.UTC(y, m - 1, d),
  )
}

const STATES: Readonly<Record<LicenceState, MessageKey>> = {
  none: 'licenceSettings.state.none',
  valid: 'licenceSettings.state.valid',
  updatesEnded: 'licenceSettings.state.updatesEnded',
  revoked: 'licenceSettings.state.revoked',
  invalid: 'licenceSettings.state.invalid',
}

export function stateSentence(licence: LicenceSnapshot, locale: string): string {
  if (licence.state === 'none' && !licence.gated) return t('licenceSettings.ungated')
  if (licence.state === 'none' && licence.code)
    return format(t('licenceSettings.state.unreadable'), { code: licence.code })
  return format(t(STATES[licence.state]), {
    date: licence.updatesUntil ? licenceDate(licence.updatesUntil, locale) : '',
    code: licence.code ?? '',
  })
}

/** Why sync or AI is locked; a licence that does not cover this version says so. */
export function lockedText(feature: 'sync' | 'ai', licence: LicenceSnapshot, locale: string) {
  if (licence.state === 'updatesEnded' && licence.updatesUntil)
    return format(t('licence.locked.updatesEnded'), {
      date: licenceDate(licence.updatesUntil, locale),
    })
  return t(feature === 'sync' ? 'licence.locked.sync' : 'licence.locked.ai')
}

/** Renew where the licence is known and has run out; Buy otherwise. */
export const renewable = (licence: LicenceSnapshot): licence is LicenceSnapshot & { id: string } =>
  licence.state === 'updatesEnded' && licence.id !== null

export interface LicenceOffer {
  readonly id: string
  readonly licensee: string
  readonly updatesUntil: string
  readonly state: LicenceState
}

export type LinkPlan =
  | { readonly kind: 'add' }
  | { readonly kind: 'same' }
  | { readonly kind: 'ask'; readonly message: string; readonly detail: string }

/** A link adds a licence to a device that holds none, and asks before it replaces one. */
export function planLicenceLink(
  current: LicenceSnapshot,
  offer: LicenceOffer,
  locale: string,
): LinkPlan {
  if (current.state === 'none' && current.code === null) return { kind: 'add' }
  const until = licenceDate(offer.updatesUntil, locale)
  if (current.id === null || current.licensee === null || current.updatesUntil === null)
    return {
      kind: 'ask',
      message: t('licence.replace.message'),
      detail: format(t('licence.replace.detailInvalid'), { licensee: offer.licensee, until }),
    }
  const currentUntil = licenceDate(current.updatesUntil, locale)
  if (current.id === offer.id) {
    if (current.updatesUntil === offer.updatesUntil && current.licensee === offer.licensee)
      return { kind: 'same' }
    return {
      kind: 'ask',
      message: t('licence.renewed.message'),
      detail: format(t('licence.renewed.detail'), { id: offer.id, until, currentUntil }),
    }
  }
  return {
    kind: 'ask',
    message: t('licence.replace.message'),
    detail: format(t('licence.replace.detail'), {
      current: current.licensee,
      currentUntil,
      licensee: offer.licensee,
      until,
    }),
  }
}
