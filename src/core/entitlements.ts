export const FEATURES = ['localNotes', 'sync', 'sharing', 'aiProviders', 'semanticSearch'] as const
export type Feature = (typeof FEATURES)[number]

/** Features that need a paid plan. Empty until pricing is decided: every feature is available today. */
export const PLAN_GATED_FEATURES: readonly Feature[] = []

/** How long a plan stays valid after the account last confirmed it, so working offline never locks a paying user out. */
export const OFFLINE_GRACE_MS = 14 * 24 * 60 * 60 * 1000

export interface AccountEntitlements {
  readonly granted: readonly Feature[]
  /** Epoch milliseconds of the last time the account service confirmed `granted`. */
  readonly confirmedAt: number
}

/** Filled by accounts (#4): the cached entitlements of the signed-in account, or null when signed out. */
export interface EntitlementSource {
  read(): AccountEntitlements | null
}

export interface Entitlements {
  has(feature: Feature): boolean
}

export interface EntitlementOptions {
  source?: EntitlementSource
  now?: () => number
  graceMs?: number
  gated?: readonly Feature[]
}

export function createEntitlements(options: EntitlementOptions = {}): Entitlements {
  const {
    source,
    now = Date.now,
    graceMs = OFFLINE_GRACE_MS,
    gated = PLAN_GATED_FEATURES,
  } = options
  return {
    has(feature) {
      if (!gated.includes(feature)) return true
      const account = source?.read()
      if (!account) return false
      const age = now() - account.confirmedAt
      // A clock set back counts as unconfirmed rather than extending the grace period.
      if (age < 0 || age > graceMs) return false
      return account.granted.includes(feature)
    },
  }
}
