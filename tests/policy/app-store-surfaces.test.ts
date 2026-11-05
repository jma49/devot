import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { en } from '../../src/renderer/src/i18n/en'
import { enPhone } from '../../src/renderer/src/i18n/phone'
import { listFiles } from '../support/git-files'
import { PRICE } from '../support/price'

// An App Store build shows no way to pay outside the App Store and no price but StoreKit's
// (docs/adr/0014-iphone-sold-on-the-app-store-with-the-licence-kept.md, What the iPhone shows).
// src/renderer/src/phone/appStoreSurfaces.test.tsx renders the phone's surfaces in one.

it('names no price and no purchase page in any message', () => {
  const offending = Object.entries({ ...en, ...enPhone })
    .filter(([, text]) => PRICE.test(text) || /\/buy\b|devot\.online/.test(text))
    .map(([key]) => key)
  expect(offending).toEqual([])
})

it('keeps the licence site in licence.ts, where Buy and Manage Devices ask the App Store switch', () => {
  const offending = listFiles('.', 'src/renderer/src')
    .filter((path) => /\.tsx?$/.test(path) && !path.includes('.test.'))
    .filter((path) => path !== 'src/renderer/src/licence.ts')
    .filter((path) => /devot\.online|\/buy\b|BUY_URL|LICENCE_SITE/.test(readFileSync(path, 'utf8')))
  expect(offending).toEqual([])
})
