// What the windows say about the licence: why a key was refused, the state in a sentence, and what
// a devot://licence link would change.
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

const STATES: Readonly<Record<LicenceState, MessageKey>> = {
  none: 'licenceSettings.state.none',
  valid: 'licenceSettings.state.valid',
  revoked: 'licenceSettings.state.revoked',
  invalid: 'licenceSettings.state.invalid',
}

export function stateSentence(licence: LicenceSnapshot): string {
  if (licence.state === 'none' && !licence.gated) return t('licenceSettings.ungated')
  if (licence.state === 'none' && licence.code)
    return format(t('licenceSettings.state.unreadable'), { code: licence.code })
  return format(t(STATES[licence.state]), { code: licence.code ?? '' })
}

export interface LicenceOffer {
  readonly id: string
  readonly licensee: string
  readonly state: LicenceState
}

export type LinkPlan =
  | { readonly kind: 'add' }
  | { readonly kind: 'same' }
  | { readonly kind: 'ask'; readonly message: string; readonly detail: string }

/** A link adds a licence to a device that holds none, and asks before it replaces one. */
export function planLicenceLink(current: LicenceSnapshot, offer: LicenceOffer): LinkPlan {
  if (current.state === 'none' && current.code === null) return { kind: 'add' }
  if (current.id === null || current.licensee === null)
    return {
      kind: 'ask',
      message: t('licence.replace.message'),
      detail: format(t('licence.replace.detailInvalid'), {
        licensee: offer.licensee,
        id: offer.id,
      }),
    }
  if (current.id === offer.id && current.licensee === offer.licensee) return { kind: 'same' }
  return {
    kind: 'ask',
    message: t('licence.replace.message'),
    detail: format(t('licence.replace.detail'), {
      current: current.licensee,
      currentId: current.id,
      licensee: offer.licensee,
      id: offer.id,
    }),
  }
}
