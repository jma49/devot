import { useCallback, useInsertionEffect, useRef, useState } from 'react'

/**
 * A function that keeps its identity from render to render and always runs
 * the latest `fn`: for callbacks handed to memoized components, which then
 * do not render again just because their owner did. Call it from events and
 * effects, never during a render.
 */
export function useStable<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn)
  // Before any layout effect, so even those run the latest one.
  useInsertionEffect(() => {
    latest.current = fn
  })
  return useCallback((...args: A) => latest.current(...args), [])
}

/**
 * `value`, or the one kept from an earlier render while `same` finds them
 * equal: derived values (counts, say) keep their identity, and memoized
 * components that take them do not render again for an equal one.
 */
export function useKept<T>(value: T, same: (kept: T, next: T) => boolean): T {
  const [kept, keep] = useState(value)
  if (kept === value || same(kept, value)) return kept
  // A value from an earlier render, kept as React allows (see useState).
  keep(() => value)
  return value
}
