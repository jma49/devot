import { useEffect, useState } from 'react'
import type { LicenceSnapshot } from '../licence'
import { licenceRowChangesAt } from './settingsRows'

/**
 * The time the Licence row is shown for, read again when the app returns to the foreground and
 * when the row's value next changes; timers stop while iOS keeps the app in the background.
 */
export function useLicenceClock(licence: LicenceSnapshot): number {
  const [now, setNow] = useState(() => Date.now())
  const next = licenceRowChangesAt(licence, now)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      const at = Date.now()
      if (next === null || at >= next) setNow(at)
      else timer = setTimeout(arm, next - at)
    }
    const shown = () => {
      if (document.visibilityState === 'visible') setNow(Date.now())
    }
    document.addEventListener('visibilitychange', shown)
    if (next !== null) arm()
    return () => {
      document.removeEventListener('visibilitychange', shown)
      clearTimeout(timer)
    }
  }, [next])
  return now
}
