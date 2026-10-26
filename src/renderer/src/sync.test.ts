import { describe, expect, it } from 'vitest'
import { linkRelay, readDevices, readPairing, relayAllowed, runsSync } from './sync'

describe('runsSync', () => {
  it('runs the engine in the first main window only', () => {
    expect(runsSync('main')).toBe(true)
    for (const label of ['main-2', 'main-10', 'note-3', 'settings', 'quick-capture']) {
      expect(runsSync(label)).toBe(false)
    }
  })
})

describe('readPairing', () => {
  const good = {
    code: '0400-E3GN-3GHJ-MC9R-7X34-TN2V-C9MN-JTDF',
    link: 'devot://pair?relay=https%3A%2F%2Frelay.example.com&code=0400E3GN3GHJMC9R7X34TN2VC9MNJTDF',
    qr: { size: 21, modules: '1'.repeat(441) },
    expires: 1_790_000_000_000,
  }

  it('takes a code, its link, its QR code and its expiry as Rust sends them', () => {
    expect(readPairing(good)).toEqual(good)
  })

  it('refuses anything else', () => {
    for (const bad of [
      null,
      'code',
      { ...good, code: '0400E3GN' },
      { ...good, link: 'https://relay.example.com' },
      { ...good, qr: { size: 21, modules: '1'.repeat(440) } },
      { ...good, qr: { size: 21, modules: '2'.repeat(441) } },
      { ...good, qr: { size: 0, modules: '' } },
      { ...good, expires: 1.5 },
    ]) {
      expect(readPairing(bad)).toBeUndefined()
    }
  })
})

describe('readDevices', () => {
  it('keeps well-formed devices only', () => {
    expect(
      readDevices([
        { id: 'abc_D-1', label: 'Devot for macOS', created: 5, current: true },
        { id: 'phone', label: 'Devot for iOS', created: 6 },
        { id: 'bad id', label: 'x', created: 1 },
        { id: 'n', label: 3, created: 1 },
        null,
      ]),
    ).toEqual([
      { id: 'abc_D-1', label: 'Devot for macOS', created: 5, current: true },
      { id: 'phone', label: 'Devot for iOS', created: 6, current: false },
    ])
    expect(readDevices({})).toEqual([])
  })
})

describe('linkRelay', () => {
  it('reads the relay a pairing link names', () => {
    expect(
      linkRelay(' devot://pair?relay=https%3A%2F%2Frelay.example.com&code=0400E3GN3GHJ '),
    ).toBe('https://relay.example.com')
  })

  it('finds none in a bare code, another link or a relay that is no web address', () => {
    for (const text of [
      '0400-E3GN-3GHJ-MC9R-7X34-TN2V-C9MN-JTDF',
      'https://relay.example.com',
      'devot://open?relay=https%3A%2F%2Frelay.example.com',
      'devot://pair?code=0400E3GN',
      'devot://pair?relay=javascript%3Aalert(1)&code=0400',
      'devot://pair?relay=not%20a%20url&code=0400',
    ]) {
      expect(linkRelay(text)).toBeUndefined()
    }
  })
})

describe('relayAllowed', () => {
  it('takes https, and http to this machine only, as Rust does', () => {
    for (const relay of [
      'https://relay.example.com',
      'http://localhost:8787',
      'http://127.0.0.1:8787',
      'http://[::1]:8787',
    ]) {
      expect(relayAllowed(relay)).toBe(true)
    }
    for (const relay of [
      'http://relay.example.com',
      'http://192.168.1.4:8787',
      'http://localhost.example.com',
      'ftp://relay.example.com',
      'not a url',
    ]) {
      expect(relayAllowed(relay)).toBe(false)
    }
  })
})
