import { afterEach, describe, expect, it, vi } from 'vitest'
import { failureReason, failureText, logFailure, withReason } from './failure'
import { t } from './i18n'

afterEach(() => vi.restoreAllMocks())

describe('failureReason', () => {
  it.each([
    ['E_NET_FAILED', 'failure.offline'],
    ['E_SYNC_OFFLINE', 'failure.offline'],
    ['E_AI_NETWORK_FAILED', 'failure.offline'],
    ['E_APP_STORE_NETWORK', 'failure.offline'],
    ['E_NET_TIMEOUT', 'failure.timeout'],
    ['E_PRINT_TIMEOUT', 'failure.timeout'],
    ['E_NET_HOST_REFUSED', 'failure.addressRefused'],
    ['E_NET_HTTPS_ONLY', 'failure.addressRefused'],
    ['E_NET_TOO_MANY_REDIRECTS', 'failure.serverRefused'],
    ['E_AI_HTTP', 'failure.serverRefused'],
    ['E_AI_PROVIDER_UNAVAILABLE', 'failure.serverUnavailable'],
    ['E_APP_STORE_UNAVAILABLE', 'failure.serverUnavailable'],
  ] as const)('words %s as %s', (code, key) => {
    expect(failureReason(code)).toBe(key)
  })

  it('has no reason for a code it cannot explain', () => {
    expect(failureReason('E_STORAGE_BUSY')).toBeUndefined()
    expect(failureReason('E_UNKNOWN')).toBeUndefined()
    expect(
      [
        'E_DATA_FOLDER_UNAVAILABLE',
        'E_AI_KEYCHAIN_UNAVAILABLE',
        'E_SYNC_ICLOUD_ACCOUNT_UNAVAILABLE',
        'E_MCP_ACCESS_UNAVAILABLE',
        'E_PLUGIN_UNAVAILABLE',
        'E_HTTP_API_UNAVAILABLE',
        'E_SPEECH_UNAVAILABLE',
      ].filter((code) => failureReason(code) !== undefined),
    ).toEqual([])
    expect(failureReason('')).toBeUndefined()
  })
})

describe('failureText', () => {
  it('says the action alone for a code it cannot explain, without the code', () => {
    const text = failureText('backups.failed', 'E_BACKUP_IO')
    expect(text).toBe(t('backups.failed'))
    expect(text).not.toContain('E_')
  })

  it('adds the plain reason for a code it can explain', () => {
    expect(failureText('syncSettings.usage.failed', 'E_NET_TIMEOUT')).toBe(
      `${t('syncSettings.usage.failed')} ${t('failure.timeout')}`,
    )
  })

  it('adds no reason after a message that gives its own advice', () => {
    expect(failureText('httpApi.notListening', 'E_NET_TIMEOUT')).toBe(t('httpApi.notListening'))
  })

  it('fills the message’s other placeholders', () => {
    expect(failureText('plugins.failed', 'E_PLUGIN_FAILED', { name: 'Word Count' })).toBe(
      'Word Count could not finish.',
    )
  })
})

describe('withReason', () => {
  it('ends a sentence before the reason that follows it', () => {
    expect(withReason('No answer', 'E_NET_FAILED')).toBe(`No answer. ${t('failure.offline')}`)
    expect(withReason('No answer.', 'E_X')).toBe('No answer.')
  })
})

describe('logFailure', () => {
  it('logs the code under the area’s code and hands it back', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(logFailure('E_BACKUP_IO', 'W_BACKUPS_FAILED')).toBe('E_BACKUP_IO')
    expect(warn).toHaveBeenCalledWith('W_BACKUPS_FAILED', 'E_BACKUP_IO')
  })

  it('logs under W_UI_FAILED by default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logFailure('E_X')
    expect(warn).toHaveBeenCalledWith('W_UI_FAILED', 'E_X')
  })
})
