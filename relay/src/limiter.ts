/**
 * A token bucket per device, in memory. A Durable Object that hibernates loses
 * it, which is harmless: it only hibernates after a quiet spell, by which time
 * every bucket has refilled.
 */
export class RateLimiter {
  private readonly capacity: number
  private readonly perSecond: number
  private readonly buckets = new Map<string, { tokens: number; at: number }>()

  constructor(capacity = 60, perSecond = 10) {
    this.capacity = capacity
    this.perSecond = perSecond
  }

  /** Takes one token for `key`: 0 when allowed, else the milliseconds until one is free. */
  take(key: string, now: number): number {
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, at: now }
    bucket.tokens = Math.min(
      this.capacity,
      bucket.tokens + (Math.max(0, now - bucket.at) / 1000) * this.perSecond,
    )
    bucket.at = now
    this.buckets.set(key, bucket)
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return 0
    }
    return Math.ceil(((1 - bucket.tokens) / this.perSecond) * 1000)
  }
}
