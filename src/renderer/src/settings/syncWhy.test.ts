import { describe, expect, it } from 'vitest'
import { en } from '../i18n/en'
import { enPhone } from '../i18n/phone'
import { setIPhoneWording } from '../i18n'
import { WHY, failureText } from './syncWhy'
import type { MessageKey } from '../i18n'

const FAILURES = (Object.keys(en) as MessageKey[]).filter((key) =>
  /^syncSettings\.[\w.]*[fF]ailed$/.test(key),
)

describe('failureText', () => {
  it('leaves no placeholder or code on screen, whatever the message or code', () => {
    expect(FAILURES.length).toBeGreaterThan(10)
    for (const phone of [false, true]) {
      setIPhoneWording(phone)
      for (const key of FAILURES)
        for (const code of [...Object.keys(WHY), 'E_SYNC_UNEXPLAINED'])
          expect(failureText(key, code), `${key} ${code}`).not.toMatch(/[{}]|E_SYNC/)
    }
    setIPhoneWording(false)
  })

  it('says the action alone for an unexplained code, and the reason for an explained one', () => {
    expect(failureText('syncSettings.devicesFailed', 'E_SYNC_UNEXPLAINED')).toBe(
      en['syncSettings.devicesFailed'],
    )
    expect(failureText('syncSettings.devicesFailed', 'E_SYNC_OFFLINE')).toBe(
      `${en['syncSettings.devicesFailed']} ${en['syncSettings.why.unreachable']}`,
    )
    expect(failureText('syncSettings.devicesFailed', 'E_NET_TIMEOUT')).toBe(
      `${en['syncSettings.devicesFailed']} ${en['failure.timeout']}`,
    )
  })

  it('says a recovery key was refused because its vault is being removed from iCloud', () => {
    expect(failureText('syncSettings.devicesFailed', 'E_SYNC_ICLOUD_LEAVING')).toBe(
      `${en['syncSettings.devicesFailed']} ${en['syncSettings.why.icloudLeaving']}`,
    )
  })

  it('ends the explanation with a full stop, also where the phone copy is a bare label', () => {
    setIPhoneWording(true)
    expect(enPhone['syncSettings.icloudFull']).toBeDefined()
    for (const code of Object.keys(WHY))
      expect(failureText('syncSettings.devicesFailed', code)).toMatch(/[.!?]$/)
    setIPhoneWording(false)
  })
})
