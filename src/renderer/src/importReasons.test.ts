import { describe, expect, it } from 'vitest'
import { t } from './i18n'
import { importReason } from './importReasons'

describe('importReason', () => {
  it('explains an import refused because the trial is over', () => {
    const reason = importReason('E_LICENCE_REQUIRED')
    expect(reason && t(reason)).toContain('trial has ended')
  })

  it('says the keychain kept the licence back, not that the trial is over', () => {
    const reason = importReason('E_LICENCE_UNREADABLE')
    expect(reason && t(reason)).toContain('keychain')
    expect(reason && t(reason)).not.toContain('trial')
  })

  it('has no reason for a code it does not know', () => {
    expect(importReason('E_SOMETHING_ELSE')).toBeNull()
    expect(importReason('toString')).toBeNull()
  })
})
