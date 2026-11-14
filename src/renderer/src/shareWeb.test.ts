import { describe, expect, it } from 'vitest'
import { initialSharePhase, shareError, shareStep, type Shared, type SharePhase } from './shareWeb'

const shared: Shared = {
  url: 'https://share.devot.online/s/abc#key',
  expiresAt: 1_800_000_000_000,
}

const unshared: SharePhase = { kind: 'unshared', lifetime: 7, error: null }
const live: SharePhase = { kind: 'shared', shared, error: null, copied: false }

describe('the Share on Web sheet', () => {
  it('opens on the status Rust reports', () => {
    const loading = initialSharePhase(1)
    expect(shareStep(loading, { kind: 'status', request: 1, shared: null })).toEqual(unshared)
    expect(shareStep(loading, { kind: 'status', request: 1, shared })).toEqual(live)
  })

  it('ignores an answer to a request it no longer waits for', () => {
    const loading = initialSharePhase(2)
    expect(shareStep(loading, { kind: 'status', request: 1, shared })).toBe(loading)
    const working = shareStep(unshared, {
      kind: 'start',
      request: 3,
      task: 'share',
    })
    expect(shareStep(working, { kind: 'done', request: 2, shared })).toBe(working)
    expect(shareStep(working, { kind: 'failed', request: 2, code: 'E_NET_OFFLINE' })).toBe(working)
  })

  it('shares with the lifetime chosen, and keeps it when sharing fails', () => {
    const month = shareStep(unshared, { kind: 'lifetime', lifetime: 30 })
    const working = shareStep(month, {
      kind: 'start',
      request: 1,
      task: 'share',
    })
    expect(working).toMatchObject({
      kind: 'working',
      task: 'share',
      lifetime: 30,
      shared: null,
    })
    expect(
      shareStep(working, {
        kind: 'failed',
        request: 1,
        code: 'E_SHARE_TOO_LARGE',
      }),
    ).toEqual({
      kind: 'unshared',
      lifetime: 30,
      error: 'shareWeb.error.tooLarge',
    })
    expect(shareStep(working, { kind: 'done', request: 1, shared })).toEqual(live)
  })

  it('updates or stops only a live share, and keeps the link when either fails', () => {
    expect(shareStep(unshared, { kind: 'start', request: 1, task: 'stop' })).toBe(unshared)
    expect(shareStep(live, { kind: 'start', request: 1, task: 'share' })).toBe(live)
    const stopping = shareStep(live, {
      kind: 'start',
      request: 1,
      task: 'stop',
    })
    expect(shareStep(stopping, { kind: 'done', request: 1, shared: null })).toEqual(unshared)
    expect(shareStep(stopping, { kind: 'failed', request: 1, code: 'E_X' })).toEqual({
      ...live,
      error: 'shareWeb.error.failed',
    })
  })

  it('says the link was copied only for a live share', () => {
    expect(shareStep(live, { kind: 'copied' })).toEqual({
      ...live,
      copied: true,
    })
    expect(shareStep(unshared, { kind: 'copied' })).toBe(unshared)
  })

  it('names each failure by its code', () => {
    expect(shareError('E_NET_TIMEOUT')).toBe('shareWeb.error.offline')
    expect(shareError('E_SHARE_RATE_LIMITED')).toBe('shareWeb.error.busy')
    expect(shareError('E_SHARE_KEYCHAIN_FAILED')).toBe('shareWeb.error.keychain')
    expect(shareError('E_SOMETHING_ELSE')).toBe('shareWeb.error.failed')
  })
})
