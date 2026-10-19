import { describe, expect, it } from 'vitest'
import { reuseServers, uiPorts } from './ports'

describe('uiPorts', () => {
  it('gives a checkout the same two neighbouring ports every time', () => {
    const a = uiPorts('/work/devot', {})
    expect(uiPorts('/work/devot', {})).toEqual(a)
    expect(a.csp).toBe(a.ui + 1)
  })

  it('gives different checkouts different ports', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 20; i++) seen.add(uiPorts(`/work/devot-wt/${i}-fix`, {}).ui)
    // 400 pairs: a collision among 20 folders is possible but a handful at most.
    expect(seen.size).toBeGreaterThan(15)
  })

  it('stays in 5200-5999, away from the ports a browser refuses', () => {
    for (let i = 0; i < 500; i++) {
      const { ui, csp } = uiPorts(`/checkout/${i}`, {})
      expect(ui).toBeGreaterThanOrEqual(5200)
      expect(csp).toBeLessThanOrEqual(5999)
    }
  })

  it('lets the environment move either port', () => {
    const base = uiPorts('/work/devot', {})
    expect(uiPorts('/work/devot', { DEVOT_UI_PORT: '6100' })).toEqual({ ui: 6100, csp: base.csp })
    expect(uiPorts('/work/devot', { DEVOT_CSP_PORT: '6101' })).toEqual({ ui: base.ui, csp: 6101 })
  })

  it('refuses a value that is not a port', () => {
    expect(() => uiPorts('/work/devot', { DEVOT_UI_PORT: 'abc' })).toThrow('Not a port')
    expect(() => uiPorts('/work/devot', { DEVOT_CSP_PORT: '70000' })).toThrow('Not a port')
  })
})

describe('reuseServers', () => {
  it('is off unless asked for', () => {
    expect(reuseServers({})).toBe(false)
    expect(reuseServers({ DEVOT_REUSE_SERVERS: '0' })).toBe(false)
  })

  it('is on locally when asked for', () => {
    expect(reuseServers({ DEVOT_REUSE_SERVERS: '1' })).toBe(true)
  })

  it('is never on in CI', () => {
    expect(reuseServers({ CI: 'true', DEVOT_REUSE_SERVERS: '1' })).toBe(false)
  })
})
