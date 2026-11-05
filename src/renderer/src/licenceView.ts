// What the windows say about the licence: why a key was refused, the state in a sentence, the
// trial's time left and its reminder, and what a devot://licence link would change.
import type { LicenceState } from '../../core/entitlements'
import { fullDate } from './format'
import { format, t, type MessageKey } from './i18n'
import {
  APP_STORE_LICENSEE,
  APP_STORE_UNREAD,
  soldOnAppStore,
  trialRunning,
  type LicenceSnapshot,
} from './licence'

const REASONS: Readonly<Record<string, MessageKey>> = {
  E_LICENCE_MALFORMED: 'licence.reason.malformed',
  E_LICENCE_UNKNOWN_KID: 'licence.reason.unknownKid',
  E_LICENCE_SIGNATURE: 'licence.reason.signature',
  E_LICENCE_KEYCHAIN: 'licence.reason.keychain',
  E_LICENCE_KEYCHAIN_UNAVAILABLE: 'licence.reason.keychain',
  E_LICENCE_KEYCHAIN_DENIED: 'licence.reason.keychainDenied',
  E_LICENCE_DEVICE_LIMIT: 'licence.reason.deviceLimit',
  E_LICENCE_ACTIVATION_REQUIRED: 'licence.reason.activationRequired',
  E_LICENCE_ACTIVATION_EXPIRED: 'licence.reason.activationExpired',
  E_LICENCE_ACTIVATION_FAILED: 'licence.reason.activationFailed',
  E_LICENCE_ACTIVATION_REFUSED: 'licence.reason.activationFailed',
  E_LICENCE_RATE_LIMITED: 'licence.reason.rateLimited',
  E_LICENCE_ACTIVATION_UNREADABLE: 'licence.reason.activationUnreadable',
  E_LICENCE_KEYS_OFF: 'licence.reason.keysOff',
  E_APP_STORE_NO_REPLY: 'licence.reason.storeNoReply',
  E_APP_STORE_UNAVAILABLE: 'licence.reason.storeUnavailable',
  E_APP_STORE_UNVERIFIED: 'licence.reason.storeUnverified',
  E_APP_STORE_NO_PRO: 'licence.reason.noPro',
  E_APP_STORE_PRODUCT: 'licence.reason.storeProduct',
  E_APP_STORE_FAMILY_SHARED: 'licence.reason.familyShared',
  E_APP_STORE_NOT_FOUND: 'licence.reason.storeUnverified',
  E_APP_STORE_MISMATCH: 'licence.reason.storeUnverified',
  E_APP_STORE_SIGNATURE: 'licence.reason.storeUnverified',
  E_APP_STORE_EXCHANGE_REFUSED: 'licence.reason.storeUnverified',
  E_APP_STORE_UNREACHABLE: 'licence.reason.storeNoReply',
  E_APP_STORE_UPSTREAM: 'licence.reason.storeUpstream',
  E_APP_STORE_EXCHANGE_FAILED: 'licence.reason.exchangeFailed',
  E_LICENCE_CONFIG: 'licence.reason.exchangeFailed',
  E_LICENCE_REVOKED: 'licence.reason.revoked',
}

/**
 * Who a licence is for, as the windows name them: a key exchanged for an App Store purchase names
 * no buyer. `inline` words it for the middle of a sentence.
 */
export const licenseeName = (licensee: string, inline = false): string =>
  licensee === APP_STORE_LICENSEE
    ? t(inline ? 'licence.appStoreLicenseeInline' : 'licence.appStoreLicensee')
    : licensee

export function licenceProblem(code: string): string {
  return format(t('licence.problem'), { reason: t(REASONS[code] ?? 'licence.reason.other'), code })
}

const LOCKED: Readonly<Record<'sync' | 'ai', readonly [MessageKey, MessageKey]>> = {
  sync: ['licence.locked.sync', 'licence.locked.syncTrialEnded'],
  ai: ['licence.locked.ai', 'licence.locked.aiTrialEnded'],
}
const LOCKED_PRO: typeof LOCKED = {
  sync: ['licence.locked.syncPro', 'licence.locked.syncProTrialEnded'],
  ai: ['licence.locked.aiPro', 'licence.locked.aiProTrialEnded'],
}

/** Why sync or AI is locked; an App Store build, which may take no key, names Devot Pro. */
export function lockedSentence(
  feature: 'sync' | 'ai',
  licence: LicenceSnapshot,
  trialEnded: boolean,
): string {
  const [locked, ended] = (soldOnAppStore(licence) ? LOCKED_PRO : LOCKED)[feature]
  return t(trialEnded ? ended : locked)
}

const STATES: Readonly<Record<LicenceState, MessageKey>> = {
  none: 'licenceSettings.state.none',
  valid: 'licenceSettings.state.valid',
  revoked: 'licenceSettings.state.revoked',
  invalid: 'licenceSettings.state.invalid',
}

export function stateSentence(licence: LicenceSnapshot): string {
  const store = licence.appStore
  if (store?.pro) return t('licenceSettings.state.purchased')
  if (store?.code === APP_STORE_UNREAD) return t('licenceSettings.state.storeReading')
  if (store?.code)
    return format(t('licenceSettings.state.storeUnread'), { problem: licenceProblem(store.code) })
  if (licence.state === 'none' && !licence.gated) return t('licenceSettings.ungated')
  if (licence.state === 'none' && licence.code)
    return format(t('licenceSettings.state.unreadable'), { problem: licenceProblem(licence.code) })
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
        licensee: licenseeName(offer.licensee, true),
        id: offer.id,
      }),
    }
  if (current.id === offer.id && current.licensee === offer.licensee) return { kind: 'same' }
  return {
    kind: 'ask',
    message: t('licence.replace.message'),
    detail: format(t('licence.replace.detail'), {
      current: licenseeName(current.licensee, true),
      currentId: current.id,
      licensee: licenseeName(offer.licensee, true),
      id: offer.id,
    }),
  }
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
/** The reminder shows once less than this is left of the trial. */
export const REMINDER_MS = DAY_MS

/** What is left in its largest unit, rounded down ("2 days", "5 hours", "40 minutes"), never under a minute. */
export function timeLeft(ms: number, locale: string): string {
  const [count, unit] =
    ms >= DAY_MS
      ? [Math.floor(ms / DAY_MS), 'day']
      : ms >= HOUR_MS
        ? [Math.floor(ms / HOUR_MS), 'hour']
        : [Math.max(1, Math.floor(ms / MINUTE_MS)), 'minute']
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(count)
}

/** Settings > Licence's line on the trial; none with a valid licence or in a build that gates nothing. */
export function trialSentence(
  licence: LicenceSnapshot,
  now: number,
  locale: string,
): string | null {
  const trial = licence.trial
  if (!licence.gated || licence.state === 'valid' || !trial) return null
  if (licence.appStore?.pro || licence.appStore?.code) return null
  if (trial.state === 'available') return t('licenceSettings.trial.available')
  if (trial.code) return format(t('licenceSettings.trial.unreadable'), { code: trial.code })
  if (trialRunning(licence, now) && trial.endsAt !== null)
    return format(t('licenceSettings.trial.running'), {
      date: fullDate(trial.endsAt, locale),
      left: timeLeft(trial.endsAt - now, locale),
    })
  return t('licenceSettings.trial.ended')
}

/** Settings > Licence's line on this device's seat; none in a build that manages none. */
export function seatSentence(licence: LicenceSnapshot): string | null {
  const seat = licence.activation
  if (!seat) return null
  const problem =
    seat.state === 'active'
      ? null
      : t(
          seat.state === 'expired'
            ? 'licenceSettings.devices.expired'
            : 'licenceSettings.devices.required',
        )
  // A refused or unreadable seat has no counts yet: say only what is missing.
  if (seat.limit === 0) return problem
  const seats = format(t('licenceSettings.devices.seats'), {
    used: String(seat.used),
    limit: String(seat.limit),
  })
  return problem ? `${seats} ${problem}` : seats
}

/** The trial ends within a day, and the reminder for this trial was not dismissed. */
export function reminderDue(
  licence: LicenceSnapshot,
  now: number,
  dismissedFor: number | null,
): boolean {
  const endsAt = licence.trial?.endsAt ?? null
  return (
    licence.gated &&
    licence.state !== 'valid' &&
    trialRunning(licence, now) &&
    endsAt !== null &&
    endsAt - now < REMINDER_MS &&
    dismissedFor !== endsAt
  )
}

const dayOf = (at: number) => {
  const date = new Date(at)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

export function reminderText(endsAt: number, now: number, locale: string): string {
  const time = new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(new Date(endsAt))
  const today = dayOf(endsAt) === dayOf(now)
  return format(t(today ? 'trial.reminder.today' : 'trial.reminder.tomorrow'), { time })
}
