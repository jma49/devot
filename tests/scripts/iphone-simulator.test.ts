import { expect, it } from 'vitest'
import { pickIphone, type SimDevices } from '../../scripts/ci/iphone-simulator'

const runtime = (version: string) =>
  `com.apple.CoreSimulator.SimRuntime.iOS-${version.replace('.', '-')}`
const device = (name: string, udid: string, state = 'Shutdown') => ({ name, udid, state })

const devices: SimDevices = {
  [runtime('27.0')]: [device('iPhone 17', 'A-27.0')],
  [runtime('27.2')]: [
    device('iPhone 18 Pro', 'B-18'),
    device('iPhone 17', 'B-17'),
    device('iPhone 17e', 'B-17e'),
  ],
  [runtime('26.5')]: [device('iPhone 17', 'C-17')],
  'com.apple.CoreSimulator.SimRuntime.watchOS-12-0': [device('Apple Watch', 'W')],
  [runtime('27.1')]: [device('iPad Pro', 'P')],
}

it('picks the iPhone 17 on the newest iOS runtime, not the first phone listed', () => {
  expect(pickIphone(devices)).toEqual({ udid: 'B-17', name: 'iPhone 17', os: '27.2' })
})

it('prefers a booted iPhone 17 when the runtime has more than one', () => {
  const two: SimDevices = {
    [runtime('27.2')]: [device('iPhone 17', 'D-1'), device('iPhone 17', 'D-2', 'Booted')],
  }
  expect(pickIphone(two).udid).toBe('D-2')
})

it('takes another iPhone when the newest runtime has no iPhone 17', () => {
  expect(pickIphone({ [runtime('27.2')]: [device('iPhone 18 Pro', 'E-18')] }).udid).toBe('E-18')
})

it('leaves out the runtimes whose StoreKit Test is broken under xcodebuild for the StoreKit tests', () => {
  const old: SimDevices = {
    [runtime('26.5')]: [device('iPhone 17', 'F-26.5')],
    [runtime('26.4')]: [device('iPhone 17', 'F-26.4')],
    [runtime('26.2')]: [device('iPhone 17', 'F-26.2')],
  }
  expect(pickIphone(old).os).toBe('26.5')
  expect(pickIphone(old, { storeKit: true }).os).toBe('26.2')
  expect(() =>
    pickIphone({ [runtime('26.5')]: old[runtime('26.5')]! }, { storeKit: true }),
  ).toThrow('E_SIMULATOR_NO_STOREKIT_RUNTIME')
  expect(pickIphone(devices, { storeKit: true })).toEqual({
    udid: 'A-27.0',
    name: 'iPhone 17',
    os: '27.0',
  })
})

it('fails clearly when the pinned runtime is not installed', () => {
  expect(pickIphone(devices, { os: '27.0' })).toEqual({
    udid: 'A-27.0',
    name: 'iPhone 17',
    os: '27.0',
  })
  expect(() => pickIphone(devices, { os: '27.3' })).toThrow('E_SIMULATOR_RUNTIME_MISSING os=27.3')
  expect(() => pickIphone({})).toThrow('E_SIMULATOR_NO_IPHONE')
})
