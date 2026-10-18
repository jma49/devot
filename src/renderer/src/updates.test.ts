import { describe, expect, it } from 'vitest'
import { readUpdateStatus, updateNotice, updateStatusText, type UpdateStatus } from './updates'

const base = { revision: 3, current: '0.3.0-beta.1', enabled: true, askedBy: null }
const status = (extra: Record<string, unknown>) => readUpdateStatus({ ...base, ...extra })!

describe('update status', () => {
  it('reads every state Rust sends', () => {
    expect(status({ state: 'idle' })).toEqual({ ...base, state: 'idle' })
    expect(status({ state: 'checking' }).state).toBe('checking')
    expect(status({ state: 'upToDate' }).state).toBe('upToDate')
    expect(status({ state: 'available', version: '0.3.0-beta.2' })).toEqual({
      ...base,
      state: 'available',
      version: '0.3.0-beta.2',
    })
    expect(status({ state: 'downloading', version: '0.4.0-beta.1', percent: 40 })).toMatchObject({
      state: 'downloading',
      percent: 40,
    })
    expect(status({ state: 'downloading', version: '1.0.0', percent: null })).toMatchObject({
      percent: null,
    })
    expect(status({ state: 'ready', version: '1.0.0' })).toMatchObject({ version: '1.0.0' })
    expect(status({ state: 'failed', code: 'E_UPDATE_CHECK_FAILED', askedBy: 'main' })).toEqual({
      ...base,
      askedBy: 'main',
      state: 'failed',
      code: 'E_UPDATE_CHECK_FAILED',
    })
  })

  it('refuses anything else, and drops a bad percent or version it only shows', () => {
    for (const bad of [
      undefined,
      null,
      'ready',
      { ...base, state: 'exploded' },
      { ...base, revision: -1, state: 'idle' },
      { ...base, revision: 1.5, state: 'idle' },
      { ...base, state: 'ready' },
      { ...base, state: 'ready', version: '<b>1.0</b>' },
      { ...base, state: 'available', version: 'v1.0.0' },
      { ...base, state: 'failed', code: 'could not connect' },
    ])
      expect(readUpdateStatus(bad)).toBeUndefined()
    expect(status({ state: 'downloading', version: '1.0.0', percent: 140 }).state).toBe(
      'downloading',
    )
    expect(status({ state: 'downloading', version: '1.0.0', percent: 140 })).toMatchObject({
      percent: null,
    })
    expect(status({ state: 'idle', current: 'dev build' }).current).toBe('')
    expect(status({ state: 'idle', enabled: 'yes' }).enabled).toBe(false)
  })
})

describe('update notice', () => {
  const notice = (s: UpdateStatus, window = 'main') => updateNotice(s, window)

  it('offers a download or a restart in every window that shows it', () => {
    expect(notice(status({ state: 'available', version: '0.3.0-beta.2' }))).toEqual({
      key: 'available:0.3.0-beta.2',
      text: 'Devot 0.3.0-beta.2 is available.',
      action: 'download',
    })
    expect(notice(status({ state: 'ready', version: '0.3.0-beta.2' }))).toEqual({
      key: 'ready:0.3.0-beta.2',
      text: 'Devot 0.3.0-beta.2 is ready to install.',
      action: 'restart',
    })
  })

  it('reports a check only to the window that asked for it', () => {
    const upToDate = status({ state: 'upToDate', askedBy: 'main' })
    expect(notice(upToDate)).toMatchObject({
      text: 'Devot 0.3.0-beta.1 is the latest version.',
      action: null,
    })
    expect(notice(upToDate, 'settings')).toBeNull()
    expect(notice(status({ state: 'upToDate' }))).toBeNull()
    const failed = status({ state: 'failed', code: 'E_UPDATE_CHECK_FAILED', askedBy: 'main' })
    expect(notice(failed)?.text).toBe(
      'Devot could not check for or install updates (E_UPDATE_CHECK_FAILED).',
    )
    expect(notice(failed, 'settings')).toBeNull()
    expect(
      notice(status({ state: 'failed', code: 'E_UPDATE_UNAVAILABLE', askedBy: 'main' }))?.text,
    ).toBe('This build of Devot does not update itself.')
    // A background download shows nothing until it is ready.
    const downloading = { state: 'downloading', version: '0.3.0-beta.2', percent: 25 }
    expect(notice(status(downloading))).toBeNull()
    expect(notice(status({ ...downloading, askedBy: 'main' }))).toEqual({
      key: 'downloading:0.3.0-beta.2',
      text: 'Downloading Devot 0.3.0-beta.2 (25%)…',
      action: null,
    })
    expect(notice(status({ state: 'idle' }))).toBeNull()
    expect(notice(status({ state: 'checking', askedBy: 'main' }))).toBeNull()
  })

  it('keeps a dismissed notice dismissed while it says the same thing', () => {
    const at = (revision: number, percent: number) =>
      notice(status({ state: 'downloading', version: '1.0.0', percent, revision, askedBy: 'main' }))
        ?.key
    expect(at(4, 10)).toBe(at(9, 80))
    const ready = (revision: number) =>
      notice(status({ state: 'ready', version: '1.0.0', revision }))?.key
    expect(ready(4)).toBe(ready(5))
  })
})

describe('the status line in Settings', () => {
  it('says where the updater is', () => {
    expect(updateStatusText(status({ state: 'idle' }))).toBe('Devot 0.3.0-beta.1.')
    expect(updateStatusText(status({ state: 'checking' }))).toBe('Checking for updates…')
    expect(updateStatusText(status({ state: 'upToDate', askedBy: 'main' }))).toBe(
      'Devot 0.3.0-beta.1 is the latest version.',
    )
    expect(
      updateStatusText(status({ state: 'downloading', version: '1.0.0', percent: null })),
    ).toBe('Downloading Devot 1.0.0…')
    expect(updateStatusText(status({ state: 'ready', version: '1.0.0' }))).toBe(
      'Devot 1.0.0 is ready to install.',
    )
    expect(updateStatusText(status({ state: 'failed', code: 'E_UPDATE_DOWNLOAD_FAILED' }))).toBe(
      'Devot could not check for or install updates (E_UPDATE_DOWNLOAD_FAILED).',
    )
  })
})
