import { afterEach, describe, expect, it, vi } from 'vitest'
import { localStore, sessionStore } from './localStore'

afterEach(() => vi.unstubAllGlobals())

describe('localStore and sessionStore', () => {
  it('returns undefined instead of throwing when WebKit refuses storage access', () => {
    const throwing = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    }
    const localDesc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    const sessionDesc = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
    Object.defineProperty(globalThis, 'localStorage', { get: throwing, configurable: true })
    Object.defineProperty(globalThis, 'sessionStorage', { get: throwing, configurable: true })
    try {
      expect(localStore()).toBeUndefined()
      expect(sessionStore()).toBeUndefined()
    } finally {
      if (localDesc) Object.defineProperty(globalThis, 'localStorage', localDesc)
      else delete (globalThis as Record<string, unknown>)['localStorage']
      if (sessionDesc) Object.defineProperty(globalThis, 'sessionStorage', sessionDesc)
      else delete (globalThis as Record<string, unknown>)['sessionStorage']
    }
  })
})
