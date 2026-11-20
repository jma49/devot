import { expect, it } from 'vitest'
import { fromBase64Url } from '../../src/core/sync/protocol'
import { corruptToken } from './client'

it.each(['AA', 'BA', 'CA', '_w'])('changes the MAC of a token ending in %s', (suffix) => {
  const mac = 'A'.repeat(41) + suffix
  const token = `device.random.${mac}`
  const corrupted = corruptToken(token)
  expect(corrupted).not.toBe(token)
  expect(corrupted.startsWith('device.random.')).toBe(true)
  const decoded = fromBase64Url(corrupted.split('.')[2])
  expect(decoded).not.toBeNull()
  expect(decoded).not.toEqual(fromBase64Url(mac))
})
