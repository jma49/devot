/** `value` within `low` and `high`; `high` wins when it is below `low`. */
export const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value))
