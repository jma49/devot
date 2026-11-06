export const FEATURES = [
  'localNotes',
  'editing',
  'sync',
  'sharing',
  'aiProviders',
  'semanticSearch',
] as const
export type Feature = (typeof FEATURES)[number]

/**
 * What a licence or a running trial unlocks (docs/adr/0006-source-available-and-sold-once.md):
 * reading, searching, copying and exporting notes (`localNotes`) stay free; changing them
 * (`editing`) does not.
 */
export const PLAN_GATED_FEATURES: readonly Feature[] = [
  'editing',
  'sync',
  'aiProviders',
  'semanticSearch',
]

export type Plan = 'pro'

/** A licence names a plan, not features, so a paid feature added later reaches every licence. */
const PLAN_FEATURES: Readonly<Record<Plan, readonly Feature[]>> = {
  pro: PLAN_GATED_FEATURES,
}

export const LICENCE_STATES = ['none', 'valid', 'revoked', 'invalid'] as const
export type LicenceState = (typeof LICENCE_STATES)[number]

/** `available`: an App Store build whose Apple account has not started the Trial yet. */
export const TRIAL_STATES = ['running', 'ended', 'available'] as const
export type TrialState = (typeof TRIAL_STATES)[number]

/** Where the trial's start is kept: this device's keychain, or the App Store's Trial purchase. */
export type TrialSource = 'keychain' | 'purchase'

/** An App Store build's purchase (docs/adr/0014-iphone-sold-on-the-app-store-with-the-licence-kept.md). */
export type Purchase = 'pro'

export interface LicenceEntitlements {
  /** False while the build holds no production key: then nothing is gated. */
  readonly enforced: boolean
  readonly state: LicenceState
  readonly plan: Plan | null
  /** The 30-day trial; unknown counts as ended. */
  readonly trial?: TrialState | null
  readonly trialSource?: TrialSource | null
  /** Devot Pro bought on the App Store by this Apple account, as Rust checked it. */
  readonly purchase?: Purchase | null
  /** This device's seat: a key alone is not enough once seats are managed. */
  readonly activation?: 'active' | 'required' | 'expired' | null
}

/** The licence as Rust checked it (src-tauri/src/licence), or null when it is not known. */
export interface EntitlementSource {
  read(): LicenceEntitlements | null
}

export interface Entitlements {
  has(feature: Feature): boolean
}

export interface EntitlementOptions {
  source?: EntitlementSource
  gated?: readonly Feature[]
}

/** Checked offline only: a licence never expires, and the source says whether the trial runs. */
export function createEntitlements(options: EntitlementOptions = {}): Entitlements {
  const { source, gated = PLAN_GATED_FEATURES } = options
  return {
    has(feature) {
      if (!gated.includes(feature)) return true
      const licence = source?.read()
      if (!licence) return false
      if (!licence.enforced) return true
      if (licence.purchase === 'pro') return PLAN_FEATURES.pro.includes(feature)
      if (licence.activation != null && licence.activation !== 'active')
        return licence.trial === 'running'
      if (licence.state === 'valid' && licence.plan !== null)
        return PLAN_FEATURES[licence.plan]?.includes(feature) ?? false
      return licence.trial === 'running'
    },
  }
}
