/**
 * The phone's core as the native screens' operations reach it: an operation that comes while the
 * core is still starting waits for it, and once the core failed to start each is refused with
 * `E_SCREENS_UNAVAILABLE`. Only the first `open` or `fail` counts.
 */
export interface CoreGate<T> {
  readonly started: () => Promise<T>
  readonly open: (core: T) => void
  readonly fail: () => void
}

export function createCoreGate<T>(): CoreGate<T> {
  let open: (core: T) => void = () => {}
  let fail: () => void = () => {}
  const started = new Promise<T>((resolve, reject) => {
    open = resolve
    fail = () => reject(new Error('E_SCREENS_UNAVAILABLE'))
  })
  // Each caller hears the refusal; with none waiting it is not an unhandled rejection.
  started.catch(() => {})
  return { started: () => started, open, fail }
}
