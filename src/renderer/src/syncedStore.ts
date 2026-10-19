// A value Rust keeps for every window (the editor settings, the keyboard
// shortcut changes): Rust answers each read and change with the value and a
// revision, and after each change sends every window the same. The revision
// goes up by one with each stored change, so a window keeps only the newest
// it has seen (two changes can announce themselves out of order). A window
// applies its own changes at once, keeps them on top of what Rust reports
// until Rust has answered (a failed change is dropped), and sends them one
// at a time, in order, so the last one sent is the one that stays stored.

export interface Revision<V> {
  revision: number
  value: V
}

export interface SyncedStore<V, P> {
  current(): V
  subscribe(notify: () => void): () => void
  confirm(reported: Revision<V> | undefined): void
  /**
   * Applies `patch` here at once and sends it with `send`, after the changes
   * sent before it; resolves with the value in effect once Rust has answered,
   * or rejects with Rust's error (the patch is dropped).
   */
  change(patch: P, send: (patch: P) => Promise<Revision<V> | undefined>): Promise<V>
}

export function createSyncedStore<V, P>(options: {
  initial: Revision<V>
  apply: (value: V, patch: P) => V
  same: (a: V, b: V) => boolean
  confirmed?: (reported: Revision<V>) => void
}): SyncedStore<V, P> {
  let confirmed = options.initial.value
  let confirmedRevision = options.initial.revision
  const inFlight: P[] = []
  let current = confirmed
  const subscribers = new Set<() => void>()
  let queue: Promise<unknown> = Promise.resolve()

  const recompute = () => {
    const next = inFlight.reduce(options.apply, confirmed)
    if (options.same(current, next)) return
    current = next
    for (const notify of subscribers) notify()
  }

  const confirm = (reported: Revision<V> | undefined) => {
    if (!reported || reported.revision <= confirmedRevision) return
    confirmedRevision = reported.revision
    confirmed = reported.value
    options.confirmed?.(reported)
    recompute()
  }

  return {
    current: () => current,
    subscribe(notify) {
      subscribers.add(notify)
      return () => subscribers.delete(notify)
    },
    confirm,
    change(patch, send) {
      inFlight.push(patch)
      recompute()
      const run = queue.then(async () => {
        try {
          confirm(await send(patch))
        } finally {
          inFlight.splice(inFlight.indexOf(patch), 1)
          recompute()
        }
        return current
      })
      queue = run.catch(() => undefined)
      return run
    },
  }
}
