export const FEATURES = ['localNotes', 'sync', 'sharing', 'aiProviders', 'semanticSearch'] as const
export type Feature = (typeof FEATURES)[number]

/** What a licence unlocks (docs/adr/0006-source-available-and-sold-once.md); everything else is free. */
export const PLAN_GATED_FEATURES: readonly Feature[] = ['sync', 'aiProviders', 'semanticSearch']

export type Plan = 'pro'

/** A licence names a plan, not features, so a paid feature added later reaches every licence. */
export const PLAN_FEATURES: Readonly<Record<Plan, readonly Feature[]>> = {
  pro: PLAN_GATED_FEATURES,
}

export const LICENCE_STATES = ['none', 'valid', 'revoked', 'invalid'] as const
export type LicenceState = (typeof LICENCE_STATES)[number]

export interface LicenceEntitlements {
  /** False while the build holds no production key: then nothing is gated. */
  readonly enforced: boolean
  readonly state: LicenceState
  readonly plan: Plan | null
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

/** Checked offline only: nothing here expires with time, since a licence never does. */
export function createEntitlements(options: EntitlementOptions = {}): Entitlements {
  const { source, gated = PLAN_GATED_FEATURES } = options
  return {
    has(feature) {
      if (!gated.includes(feature)) return true
      const licence = source?.read()
      if (!licence) return false
      if (!licence.enforced) return true
      if (licence.state !== 'valid' || licence.plan === null) return false
      return PLAN_FEATURES[licence.plan]?.includes(feature) ?? false
    },
  }
}
