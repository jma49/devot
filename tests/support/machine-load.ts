import { cpus, loadavg } from 'node:os'
import { setOverloadProbe } from './budget'

// Vitest setup: locally, a one-minute load average above the CPU count means an overloaded machine
// (re-read at every check); CI never is.
const ci = Boolean(process.env['CI'])

export function machineOverloaded(): boolean {
  return !ci && loadavg()[0]! > cpus().length
}

setOverloadProbe(machineOverloaded)
