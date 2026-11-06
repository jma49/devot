import { expect, it } from 'vitest'
import { en } from '../../src/renderer/src/i18n/en'
import { enPhone } from '../../src/renderer/src/i18n/phone'

// Error codes go to the log, never into what a person reads (docs/specs/quality.md).
const CODE_SLOT = /\{codes?\}/
const CODE_TEXT = /\b[EW]_[A-Z][A-Z0-9_]*/

const offenders = (catalog: Readonly<Record<string, string | undefined>>) =>
  Object.entries(catalog)
    .filter(([, text]) => text !== undefined && (CODE_SLOT.test(text) || CODE_TEXT.test(text)))
    .map(([key, text]) => `${key}: ${text}`)

it('no English message shows an error code', () => {
  expect(offenders(en)).toEqual([])
})

it('no iPhone wording shows an error code', () => {
  expect(offenders(enPhone)).toEqual([])
})

it('the check catches a code slot and a written code', () => {
  expect(
    offenders({
      a: 'The backup failed ({code}).',
      b: 'Sync stopped (E_SYNC_OFFLINE).',
      c: 'Warned W_LOCK_POISONED',
      d: 'The backup failed.',
      e: 'Sends error codes, never note text',
    }),
  ).toEqual([
    'a: The backup failed ({code}).',
    'b: Sync stopped (E_SYNC_OFFLINE).',
    'c: Warned W_LOCK_POISONED',
  ])
})
