import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from '../support/temp-dirs'

// What fails before any Apple tool runs; macos-sign.bench.test.ts signs on a Mac.
const SCRIPT = 'scripts/release/macos-sign.sh'
const IDENTITY = 'Developer ID Application: Devot Test (TESTTEAM01)'
const CREDENTIALS = {
  APPLE_CERTIFICATE: 'Y2VydGlmaWNhdGU=',
  APPLE_CERTIFICATE_PASSWORD: 'p12-password-value',
  APPLE_SIGNING_IDENTITY: IDENTITY,
  APPLE_API_KEY_P8: '-----BEGIN PRIVATE KEY-----\napi-key-text\n-----END PRIVATE KEY-----',
  APPLE_API_KEY_ID: 'KEY1234567',
  APPLE_API_ISSUER_ID: '00000000-0000-0000-0000-000000000000',
}

function run(env: Record<string, string>, ...args: string[]) {
  const dir = tempDir('devot-macos-sign-')
  return runIn(dir, env, ...args)
}

function runIn(dir: string, env: Record<string, string>, ...args: string[]) {
  mkdirSync(join(dir, 'Devot.app', 'Contents'), { recursive: true })
  const result = spawnSync(SCRIPT, [...args, join(dir, 'Devot.app'), join(dir, 'out')], {
    env: { PATH: process.env['PATH'] ?? '', RUNNER_TEMP: dir, ...env },
    encoding: 'utf8',
  })
  return { status: result.status, output: result.stdout + result.stderr }
}

function without(...names: (keyof typeof CREDENTIALS)[]) {
  return Object.fromEntries(
    Object.entries(CREDENTIALS).filter(([name]) => !names.includes(name as never)),
  )
}

describe('the signing script', () => {
  it('names every credential the release environment lacks, before it does anything', () => {
    const { status, output } = run(without('APPLE_CERTIFICATE_PASSWORD', 'APPLE_API_ISSUER_ID'))
    expect(status).toBe(1)
    expect(output).toMatch(
      /^::error::E_SIGN_CREDENTIALS_MISSING: APPLE_CERTIFICATE_PASSWORD APPLE_API_ISSUER_ID not set/m,
    )
    expect(output).not.toContain('Importing')
  })

  it('needs no API key when notarization is skipped', () => {
    const { output } = run(
      without('APPLE_API_KEY_P8', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER_ID', 'APPLE_CERTIFICATE'),
      '--skip-notarization',
    )
    expect(output).toMatch(/E_SIGN_CREDENTIALS_MISSING: APPLE_CERTIFICATE not set/)
  })

  it('refuses an identity that does not name a Developer ID Application certificate and its team', () => {
    for (const identity of [
      'Apple Development: Devot Test (TESTTEAM01)',
      'Developer ID Application: Devot Test',
      'Developer ID Application: Devot Test (team)',
      '0123456789ABCDEF0123456789ABCDEF01234567',
    ]) {
      const { status, output } = run({ ...CREDENTIALS, APPLE_SIGNING_IDENTITY: identity })
      expect({ identity, status }).toEqual({ identity, status: 1 })
      expect(output).toContain('::error::E_SIGN_IDENTITY_FORM')
    }
  })

  it('never prints a secret, even when it fails', () => {
    for (const env of [CREDENTIALS, { ...CREDENTIALS, APPLE_SIGNING_IDENTITY: 'x' }]) {
      const { output } = run(env)
      for (const secret of ['p12-password-value', 'Y2VydGlmaWNhdGU=', 'api-key-text'])
        expect(output).not.toContain(secret)
    }
  })

  it('leaves the keychain search list alone when it stops before adding its keychain', () => {
    const dir = tempDir('devot-macos-sign-')
    const bin = join(dir, 'bin')
    const calls = join(dir, 'security-calls')
    mkdirSync(bin)
    writeFileSync(
      join(bin, 'security'),
      `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\n[ "$1" != import ]\n`,
    )
    writeFileSync(join(bin, 'uuidgen'), '#!/bin/bash\necho throwaway-keychain-password\n')
    chmodSync(join(bin, 'security'), 0o755)
    chmodSync(join(bin, 'uuidgen'), 0o755)
    const { status, output } = runIn(
      dir,
      { ...CREDENTIALS, PATH: `${bin}:${process.env['PATH'] ?? ''}` },
      '--search-list',
    )
    expect(status).toBe(1)
    expect(output).toMatch(/::error::E_SIGN_CERTIFICATE_(IMPORT|UNREADABLE)/)
    const made = readFileSync(calls, 'utf8').split('\n')
    expect(made.some((call) => call.startsWith('delete-keychain '))).toBe(true)
    expect(made.filter((call) => call.startsWith('list-keychains'))).toEqual([])
  })

  // Gatekeeper's checks need a notarized build, so the local test cannot run them.
  it('checks the signature, the ticket and Gatekeeper on the app and the dmg', () => {
    const script = readFileSync(SCRIPT, 'utf8')
    for (const check of [
      'codesign --verify --deep --strict "$app"',
      'codesign -d --entitlements - --xml "$path"',
      'xcrun stapler validate "$app"',
      'spctl -a -t exec -vv "$app"',
      'xcrun stapler validate "$dmg"',
      'spctl -a -t open --context context:primary-signature -vv "$dmg"',
      'notary submit "$file" --wait',
      'notary log "$id"',
    ])
      expect(script).toContain(check)
    expect(script).toMatch(/sign --options runtime "\$app"\n/)
    expect(script).not.toMatch(/--entitlements [^-]|login\.keychain|default-keychain|set -x/)
  })
})
