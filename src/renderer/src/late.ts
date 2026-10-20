import { useEffect, useState } from 'react'

/** How long a note may take to load before its body shows as loading. */
export const BODY_PLACEHOLDER_MS = 150

/** True once `on` has held for `ms`; false in the same render `on` turns false. */
export function useLate(on: boolean, ms: number): boolean {
  const [late, setLate] = useState(false)
  useEffect(() => {
    if (!on) return
    const timer = setTimeout(() => setLate(true), ms)
    return () => {
      clearTimeout(timer)
      setLate(false)
    }
  }, [on, ms])
  return on && late
}
