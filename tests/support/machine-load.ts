import { cpus, loadavg } from 'node:os'
import { setOverloadProbe } from './budget'

// Vitest setup file (runs before every test file, in Node). Locally, a
// one-minute load average above the CPU count means the machine is
// overloaded; the load is read again at every check. CI never is.
const ci = Boolean(process.env['CI'])

export function machineOverloaded(): boolean {
  return !ci && loadavg()[0]! > cpus().length
}

setOverloadProbe(machineOverloaded)
