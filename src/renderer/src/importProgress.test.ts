import { describe, expect, it, vi } from 'vitest'
import { forgetScanFound, scanFound, setScanFound, subscribeScanFound } from './importProgress'

describe('scan progress store', () => {
  it('keeps what each scan found and tells subscribers, without App state', () => {
    const heard = vi.fn<() => void>()
    const stop = subscribeScanFound(heard)
    expect(scanFound(1)).toEqual({ files: 0, images: 0 })
    setScanFound(1, { files: 2, images: 1 })
    setScanFound(2, { files: 5, images: 0 })
    expect(heard).toHaveBeenCalledTimes(2)
    expect(scanFound(1)).toEqual({ files: 2, images: 1 })
    // The same snapshot until it changes, as useSyncExternalStore needs.
    expect(scanFound(1)).toBe(scanFound(1))
    expect(scanFound(null)).toBe(scanFound(99))
    forgetScanFound(1)
    expect(scanFound(1)).toEqual({ files: 0, images: 0 })
    expect(scanFound(2)).toEqual({ files: 5, images: 0 })
    stop()
    setScanFound(3, { files: 1, images: 1 })
    expect(heard).toHaveBeenCalledTimes(2)
  })
})
