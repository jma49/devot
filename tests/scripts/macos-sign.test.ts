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

  it('unlocks the keychain again before signing the dmg, after the notarization wait', () => {
    const script = readFileSync(SCRIPT, 'utf8')
    expect(script).toMatch(
      /macos-dmg\.sh" "\$app" "\$dmg"\n(?:#.*\n)*security unlock-keychain -p "\$keychain_password" "\$keychain"\nsign "\$dmg"/,
    )
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
    ])
      expect(script).toContain(check)
    expect(script).toMatch(/sign --options runtime "\$app"\n/)
    expect(script).not.toMatch(/--entitlements [^-]|login\.keychain|default-keychain|set -x/)
  })
})

describe('the notarization step', () => {
  const NOTARIZE = 'scripts/release/macos-notarize.sh'
  const KEY_TEXT = 'api-key-text'

  type Plan = {
    submitFailures?: number
    waitFailures?: number
    finalStatus?: string
    stuck?: boolean
  }

  function notarize(plan: Plan, env: Record<string, string> = {}) {
    const dir = tempDir('devot-notarize-')
    const bin = join(dir, 'bin')
    const state = join(dir, 'state')
    mkdirSync(bin)
    mkdirSync(state)
    writeFileSync(join(dir, 'AuthKey.p8'), KEY_TEXT)
    writeFileSync(join(dir, 'file.zip'), 'zip')
    const count = (name: string) =>
      `n=$(cat ${JSON.stringify(state)}/${name} 2>/dev/null || echo 0); n=$((n + 1)); echo $n > ${JSON.stringify(state)}/${name}`
    writeFileSync(
      join(bin, 'xcrun'),
      [
        '#!/bin/bash',
        `printf '%s\\n' "$*" >> ${JSON.stringify(state)}/calls`,
        'case $2 in',
        `  submit) ${count('submit')}`,
        `    if [ $n -le ${plan.submitFailures ?? 0} ]; then echo 'Error: network down' >&2; exit 1; fi`,
        `    echo '{"id" : "sub-1234", "message" : "Successfully uploaded file"}' ;;`,
        `  wait) ${count('wait')}`,
        `    if [ $n -le ${plan.waitFailures ?? 0} ] || ${plan.stuck ? 'true' : 'false'}; then`,
        `      echo '{"message":"Timeout of 1 second(s) was reached"}' >&2; exit 1; fi`,
        `    touch ${JSON.stringify(state)}/done ;;`,
        `  info) if [ -e ${JSON.stringify(state)}/done ]; then`,
        `      echo '{"id" : "sub-1234", "status" : "${plan.finalStatus ?? 'Accepted'}"}'`,
        `    else echo '{"id" : "sub-1234", "status" : "In Progress"}'; fi ;;`,
        `  log) echo '{"issues":[{"message":"The binary is invalid."}]}' > "$4" ;;`,
        'esac',
      ].join('\n'),
    )
    chmodSync(join(bin, 'xcrun'), 0o755)
    const result = spawnSync(NOTARIZE, [join(dir, 'file.zip'), 'Devot.app'], {
      env: {
        PATH: `${bin}:${process.env['PATH'] ?? ''}`,
        RUNNER_TEMP: dir,
        NOTARY_KEY_FILE: join(dir, 'AuthKey.p8'),
        APPLE_API_KEY_ID: 'KEY1234567',
        APPLE_API_ISSUER_ID: '00000000-0000-0000-0000-000000000000',
        NOTARY_RETRY_SECONDS: '0',
        NOTARY_WAIT_SECONDS: '60',
        ...env,
      },
      encoding: 'utf8',
    })
    const calls = readFileSync(join(state, 'calls'), 'utf8').trim().split('\n')
    return { status: result.status, output: result.stdout + result.stderr, calls }
  }

  const verbs = (calls: string[]) => calls.map((call) => call.split(' ')[1])

  it('submits without waiting, prints the ID, waits again after a timeout, and reads Accepted', () => {
    const { status, output, calls } = notarize({ waitFailures: 1 })
    expect(status).toBe(0)
    expect(output).toContain('Submitted Devot.app as notarization sub-1234')
    expect(output).toContain('Notarization sub-1234 of Devot.app: Accepted')
    expect(verbs(calls)).toEqual(['submit', 'wait', 'info', 'wait', 'info'])
    expect(calls[0]).not.toContain('--wait')
    expect(calls[1]).toMatch(/^notarytool wait sub-1234 --timeout \d+s /)
    expect(output).not.toContain(KEY_TEXT)
  })

  it('submits again up to three times on a transport error, then names the failure', () => {
    const retried = notarize({ submitFailures: 2 })
    expect(retried.status).toBe(0)
    expect(verbs(retried.calls).filter((verb) => verb === 'submit')).toHaveLength(3)

    const failed = notarize({ submitFailures: 3 })
    expect(failed.status).toBe(1)
    expect(failed.output).toContain(
      '::error::E_SIGN_NOTARIZATION_REFUSED: Devot.app was not submitted',
    )
    expect(verbs(failed.calls)).toEqual(['submit', 'submit', 'submit'])
  })

  it('fetches the notary log and fails with the ID when Apple answers Invalid', () => {
    const { status, output, calls } = notarize({ finalStatus: 'Invalid' })
    expect(status).toBe(1)
    expect(output).toContain('The notary log of submission sub-1234:')
    expect(output).toContain('The binary is invalid.')
    expect(output).toMatch(
      /::error::E_SIGN_NOTARIZATION_REFUSED: Devot\.app ended as Invalid \(submission sub-1234\)/,
    )
    expect(verbs(calls)).toContain('log')
    expect(output).not.toContain(KEY_TEXT)
  })

  it('fails with E_SIGN_NOTARIZATION_TIMEOUT and the ID when the budget runs out', () => {
    const { status, output, calls } = notarize(
      { stuck: true },
      { NOTARY_WAIT_SECONDS: '2', NOTARY_RETRY_SECONDS: '1' },
    )
    expect(status).toBe(1)
    expect(output).toMatch(
      /::error::E_SIGN_NOTARIZATION_TIMEOUT: .*\(submission sub-1234\).*re-run the failed jobs/,
    )
    expect(verbs(calls)).not.toContain('log')
    expect(calls.filter((call) => call.includes(' submit ')).length).toBe(1)
    expect(output).not.toContain(KEY_TEXT)
  })

  it('is called by the signing script for the app and the dmg with a shared budget', () => {
    const script = readFileSync(SCRIPT, 'utf8')
    expect(script).toContain('"$script_dir/macos-notarize.sh"')
    expect(script).toContain('NOTARY_WAIT_MINUTES')
  })
})
