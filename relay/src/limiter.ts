/**
 * A token bucket per device, in memory. A Durable Object that hibernates loses
 * it, which is harmless: it only hibernates after a quiet spell, by which time
 * every bucket has refilled.
 */
export class RateLimiter {
  private readonly capacity: number
  private readonly perSecond: number
  private readonly buckets = new Map<string, { tokens: number; at: number }>()

  private sweptAt = 0

  constructor(capacity = 60, perSecond = 10) {
    this.capacity = capacity
    this.perSecond = perSecond
  }

  /** Buckets held; a bucket that has refilled is the same as none, so it is dropped. */
  get size(): number {
    return this.buckets.size
  }

  private refilled(bucket: { tokens: number; at: number }, now: number): number {
    return Math.min(
      this.capacity,
      bucket.tokens + (Math.max(0, now - bucket.at) / 1000) * this.perSecond,
    )
  }

  /** Runs at most once per refill period, so each call pays O(1) amortised. */
  private sweep(now: number): void {
    if (now - this.sweptAt < (this.capacity / this.perSecond) * 1000) return
    this.sweptAt = now
    for (const [key, bucket] of this.buckets) {
      if (this.refilled(bucket, now) >= this.capacity) this.buckets.delete(key)
    }
  }

  /** Takes one token for `key`: 0 when allowed, else the milliseconds until one is free. */
  take(key: string, now: number): number {
    this.sweep(now)
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, at: now }
    bucket.tokens = this.refilled(bucket, now)
    bucket.at = now
    this.buckets.set(key, bucket)
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return 0
    }
    return Math.ceil(((1 - bucket.tokens) / this.perSecond) * 1000)
  }
}
