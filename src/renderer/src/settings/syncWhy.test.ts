import { describe, expect, it } from 'vitest'
import { en } from '../i18n/en'
import { enPhone } from '../i18n/phone'
import { setIPhoneWording } from '../i18n'
import { WHY, failureText } from './syncWhy'
import type { MessageKey } from '../i18n'

const WITH_CODE = (Object.keys(en) as MessageKey[]).filter(
  (key) =>
    (en[key].match(/\{\w+\}/g) ?? []).every((slot) => slot === '{code}') &&
    en[key].includes('{code}'),
)

describe('failureText', () => {
  it('leaves no placeholder on screen, whatever the message or code', () => {
    for (const phone of [false, true]) {
      setIPhoneWording(phone)
      for (const key of WITH_CODE)
        for (const code of [...Object.keys(WHY), 'E_SYNC_UNEXPLAINED'])
          expect(failureText(key, code), `${key} ${code}`).not.toMatch(/[{}]/)
    }
    setIPhoneWording(false)
  })

  it('names an unexplained code and omits an explained one', () => {
    expect(failureText('syncSettings.devicesFailed', 'E_SYNC_UNEXPLAINED')).toContain(
      '(E_SYNC_UNEXPLAINED)',
    )
    expect(failureText('syncSettings.devicesFailed', 'E_SYNC_OFFLINE')).not.toContain('E_SYNC')
  })

  it('ends the explanation with a full stop, also where the phone copy is a bare label', () => {
    setIPhoneWording(true)
    expect(enPhone['syncSettings.icloudFull']).toBeDefined()
    for (const code of Object.keys(WHY))
      expect(failureText('syncSettings.devicesFailed', code)).toMatch(/[.!?]$/)
    setIPhoneWording(false)
  })
})
