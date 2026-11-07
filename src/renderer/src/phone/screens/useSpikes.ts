import { useEffect, useRef } from 'react'
import type { Core } from '../../core-client'
import { syncSnapshot } from '../../sync'

/** Installs the spike harness's page probes (spikes.ts) in a debug build. */
export function useSpikes(core: Core | null): void {
  const current = useRef(core)
  useEffect(() => {
    current.current = core
  })
  useEffect(() => {
    if (!DEVOT_SPIKES) return
    let remove: (() => void) | undefined
    let gone = false
    void import('./spikes').then(({ installSpikes }) => {
      if (gone) return
      remove = installSpikes(() => {
        const running = current.current
        if (!running) return undefined
        return {
          ping: () => running.excerpts([]),
          sync: () => ({ enabled: syncSnapshot().enabled, state: syncSnapshot().status.state }),
          touchSync: () => void running.syncTouch().catch(() => undefined),
        }
      })
    })
    return () => {
      gone = true
      remove?.()
    }
  }, [])
}
