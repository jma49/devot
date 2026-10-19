// Median and p90 hold up against the odd slow run where a mean does not.
export interface Summary {
  n: number
  median: number
  p90: number
  min: number
  max: number
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!
}

export function round(value: number, digits = 1): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

export function summarize(values: readonly number[]): Summary {
  return {
    n: values.length,
    median: round(percentile(values, 0.5)),
    p90: round(percentile(values, 0.9)),
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
  }
}
