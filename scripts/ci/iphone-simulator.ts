import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// CI helper: reads `xcrun simctl list devices available --json` on stdin and prints the UDID of the
// iPhone simulator the iPhone tests run on: an iPhone 17 (a booted one first) on the newest iOS
// runtime, or that runtime's first iPhone. `--os 27.2` pins the runtime and fails when it is
// missing. `--storekit` leaves out the runtimes whose StoreKit Test is broken under xcodebuild:
// iOS 26.4 refuses SKTestSession's configuration even for a development build, and iOS 26.5
// leaves a fresh purchase out of the current entitlements until the next sync (FB22237318);
// iOS 27.2 never returns from a purchase given a simulated error and sends no transaction update
// for a refund (seen 2026-11-07 on two fresh iPhone 17 simulators).

export type SimDevices = Record<string, { name: string; udid: string; state?: string }[]>
export interface Iphone {
  udid: string
  name: string
  os: string
}

const STOREKIT_BROKEN = ['26.4', '26.5', '27.2']
const PREFERRED = 'iPhone 17'

export function pickIphone(
  devices: SimDevices,
  options: { os?: string | undefined; storeKit?: boolean } = {},
): Iphone {
  const runtimes = Object.entries(devices).flatMap(([id, list]) => {
    const match = /\.iOS-(\d+)-(\d+)$/.exec(id)
    const phones = list.filter((d) => d.name.startsWith('iPhone'))
    return match && phones.length ? [{ major: +match[1]!, minor: +match[2]!, phones }] : []
  })
  if (!runtimes.length) throw new Error('E_SIMULATOR_NO_IPHONE')
  const os = (r: { major: number; minor: number }) => `${r.major}.${r.minor}`
  let usable = runtimes
  if (options.os) {
    usable = runtimes.filter((r) => os(r) === options.os)
    if (!usable.length) {
      const installed = [...new Set(runtimes.map(os))].join(',')
      throw new Error(`E_SIMULATOR_RUNTIME_MISSING os=${options.os} installed=${installed}`)
    }
  }
  if (options.storeKit) {
    usable = usable.filter((r) => !STOREKIT_BROKEN.includes(os(r)))
    if (!usable.length) throw new Error('E_SIMULATOR_NO_STOREKIT_RUNTIME')
  }
  const newest = usable.reduce((a, b) => ((b.major - a.major || b.minor - a.minor) > 0 ? b : a))
  const phones = usable.filter((r) => os(r) === os(newest)).flatMap((r) => r.phones)
  const rank = (d: { name: string; state?: string }) =>
    (d.name === PREFERRED ? 2 : 0) + (d.state === 'Booted' ? 1 : 0)
  const phone = phones.reduce((a, b) => (rank(b) > rank(a) ? b : a))
  return { udid: phone.udid, name: phone.name, os: os(newest) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const at = args.indexOf('--os')
  const os = at >= 0 ? args[at + 1] : undefined
  const { devices } = JSON.parse(readFileSync(0, 'utf8')) as { devices: SimDevices }
  const phone = pickIphone(devices, { os, storeKit: args.includes('--storekit') })
  console.error(`simulator: ${phone.name}, iOS ${phone.os} (${phone.udid})`)
  console.log(phone.udid)
}
