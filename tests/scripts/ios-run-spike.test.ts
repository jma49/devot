import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from '../support/temp-dirs'

const SCRIPT = 'scripts/ios/run-spike.sh'
const BUNDLE = /PRODUCT_BUNDLE_IDENTIFIER: (\S+)/.exec(
  readFileSync('src-tauri/gen/apple/project.yml', 'utf8'),
)?.[1]

/**
 * A stand-in for xcrun that logs each call and plays a phone holding the `before` report until the
 * app is launched and the `after` one from then on.
 */
function fakeXcrun(after: object | null, devices: object[], before: object | null = null) {
  const dir = tempDir('devot-run-spike-')
  const log = join(dir, 'calls.log')
  const source = join(dir, 'report.json')
  const next = join(dir, 'next.json')
  if (before) writeFileSync(source, JSON.stringify(before))
  if (after) writeFileSync(next, JSON.stringify(after))
  writeFileSync(join(dir, 'devices.json'), JSON.stringify({ result: { devices } }))
  const xcrun = join(dir, 'xcrun')
  writeFileSync(
    xcrun,
    `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
while [ $# -gt 0 ]; do
  case "$1" in
  launch) [ -f "${next}" ] && cp "${next}" "${source}" ;;
  --json-output) cp "${join(dir, 'devices.json')}" "$2" ;;
  --destination) [ -f "${source}" ] && cp "${source}" "$2" || exit 1 ;;
  esac
  shift
done
`,
  )
  chmodSync(xcrun, 0o755)
  return { dir, log }
}

function run(args: string[], fake: { dir: string }, timeout = '10') {
  const out = join(fake.dir, 'out')
  const result = spawnSync('sh', [SCRIPT, ...args], {
    env: {
      PATH: `${fake.dir}:${process.env['PATH'] ?? ''}`,
      DEVOT_SPIKE_OUT: out,
      DEVOT_SPIKE_POLL: '0',
      DEVOT_SPIKE_TIMEOUT: timeout,
    },
    encoding: 'utf8',
  })
  return { ...result, out }
}

const PHONE = {
  identifier: 'PHONE-1',
  hardwareProperties: { platform: 'iOS' },
  connectionProperties: { tunnelState: 'connected' },
}
const report = (startedAt: string) => ({
  spike: 'S3',
  device: 'iPhone17,1',
  os: 'iOS 26.1',
  build: '0.9.0 (42)',
  startedAt,
  results: {},
  pass: true,
  notes: [],
})

describe.skipIf(process.platform !== 'darwin')('the spike run script', () => {
  it('refuses a spike it does not know, before touching a device', () => {
    const fake = fakeXcrun(null, [PHONE])
    const result = run(['S9'], fake)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('usage:')
    expect(existsSync(fake.log)).toBe(false)
  })

  it('launches the installed app with the spike, then copies its report back and prints it', () => {
    const fresh = report(new Date().toISOString())
    const fake = fakeXcrun(
      fresh,
      [
        {
          ...PHONE,
          identifier: 'MAC',
          hardwareProperties: { platform: 'macOS' },
        },
        PHONE,
      ],
      report(new Date(Date.now() - 1000).toISOString()),
    )
    const result = run(['S3'], fake)
    expect({ status: result.status, stderr: result.stderr }).toMatchObject({
      status: 0,
    })
    expect(JSON.parse(result.stdout)).toEqual(fresh)
    expect(JSON.parse(readFileSync(join(result.out, 'S3.json'), 'utf8'))).toEqual(fresh)
    const calls = readFileSync(fake.log, 'utf8').trim().split('\n')
    expect(calls[0]).toMatch(/^devicectl list devices /)
    const copy = `devicectl device copy from --quiet --device PHONE-1 --domain-type appDataContainer --domain-identifier ${BUNDLE} --source Documents/spikes/S3.json`
    expect(calls[1]).toContain(copy)
    expect(calls[2]).toBe(
      `devicectl device process launch --quiet --device PHONE-1 --terminate-existing ${BUNDLE} -- -DevotSpike S3`,
    )
    expect(calls[3]).toContain(copy)
    expect(calls.join('\n')).not.toMatch(/build|install|sign/)
  })

  it('uses the device it is given', () => {
    const fake = fakeXcrun(report(new Date().toISOString()), [])
    const result = run(['S3', 'My iPhone'], fake)
    expect(result.status).toBe(0)
    expect(readFileSync(fake.log, 'utf8')).toContain('--device My iPhone --terminate-existing')
  })

  it('fails without a connected iPhone', () => {
    const fake = fakeXcrun(null, [
      { ...PHONE, connectionProperties: { tunnelState: 'unavailable' } },
    ])
    const result = run(['S1'], fake)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('E_SPIKE_NO_DEVICE')
  })

  it('takes a report from a phone whose clock runs behind', () => {
    const late = report('2020-01-01T00:00:00.000Z')
    const result = run(['S3'], fakeXcrun(late, [PHONE]))
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(late)
  })

  it("waits for a new report and gives up on the previous run's", () => {
    const previous = report(new Date().toISOString())
    const fake = fakeXcrun(null, [PHONE], previous)
    const result = run(['S3'], fake, '0')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('E_SPIKE_REPORT_TIMEOUT spike=S3')
    expect(result.stdout).toBe('')
  })
})
