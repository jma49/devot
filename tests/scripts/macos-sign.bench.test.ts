import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { tempDir } from '../support/temp-dirs'

// Runs scripts/release/macos-sign.sh on this Mac with a throwaway self-signed identity, in a
// keychain the script makes under a temp folder; notarization is skipped, or answered by a stand-in
// xcrun. The login keychain and the keychain search list are never changed.
const SCRIPT = 'scripts/release/macos-sign.sh'
const IDENTITY = 'Developer ID Application: Devot Test (TESTTEAM01)'
const PASSWORD = 'throwaway-p12-password'
const API_KEY_TEXT = 'throwaway-api-key-text'
const TIMEOUT = 300_000

function tool(file: string, args: string[], options: { input?: string } = {}): string {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options })
}

/** codesign -d writes what it shows to stderr. */
function signature(path: string): string {
  const result = spawnSync('codesign', ['-dvv', path], { encoding: 'utf8' })
  return result.stderr
}

function throwawayCertificate(): string {
  const dir = tempDir('devot-sign-identity-')
  writeFileSync(
    join(dir, 'cert.cnf'),
    [
      '[req]',
      'distinguished_name = dn',
      'prompt = no',
      'x509_extensions = ext',
      '[dn]',
      `CN = ${IDENTITY}`,
      'OU = TESTTEAM01',
      '[ext]',
      'basicConstraints = critical,CA:false',
      'keyUsage = critical,digitalSignature',
      'extendedKeyUsage = critical,codeSigning',
      '',
    ].join('\n'),
  )
  const at = (name: string) => join(dir, name)
  tool('/usr/bin/openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-config',
    at('cert.cnf'),
    '-keyout',
    at('key.pem'),
    '-out',
    at('cert.pem'),
  ])
  tool('/usr/bin/openssl', [
    'pkcs12',
    '-export',
    '-inkey',
    at('key.pem'),
    '-in',
    at('cert.pem'),
    '-out',
    at('id.p12'),
    '-passout',
    `pass:${PASSWORD}`,
  ])
  return readFileSync(at('id.p12')).toString('base64')
}

/** An app as the build job hands it over: ad-hoc signed, with a library, the CLI script and the icon. */
function adHocApp(): string {
  const dir = tempDir('devot-sign-app-')
  const contents = join(dir, 'Devot.app', 'Contents')
  for (const sub of ['MacOS', 'Frameworks', 'Resources/bin'])
    mkdirSync(join(contents, sub), { recursive: true })
  writeFileSync(join(dir, 'main.c'), 'int main(void) { return 0; }\n')
  writeFileSync(join(dir, 'extra.c'), 'int extra(void) { return 1; }\n')
  tool('cc', ['-o', join(contents, 'MacOS', 'devot'), join(dir, 'main.c')])
  tool('cc', [
    '-dynamiclib',
    '-o',
    join(contents, 'Frameworks', 'libextra.dylib'),
    join(dir, 'extra.c'),
  ])
  copyFileSync('src-tauri/cli/devot', join(contents, 'Resources', 'bin', 'devot'))
  chmodSync(join(contents, 'Resources', 'bin', 'devot'), 0o755)
  copyFileSync('src-tauri/icons/icon.icns', join(contents, 'Resources', 'icon.icns'))
  writeFileSync(
    join(contents, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>devot</string>
<key>CFBundleIdentifier</key><string>io.github.jma49.devot.signtest</string>
<key>CFBundleIconFile</key><string>icon</string>
<key>CFBundleName</key><string>Devot</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
  )
  tool('codesign', ['--force', '--sign', '-', join(contents, 'Frameworks', 'libextra.dylib')])
  tool('codesign', ['--force', '--sign', '-', '--options', 'runtime', join(dir, 'Devot.app')])
  return join(dir, 'Devot.app')
}

function keychainState(): string {
  return tool('security', ['list-keychains', '-d', 'user']) + tool('security', ['default-keychain'])
}

interface Run {
  status: number | null
  output: string
  out: string
  scratch: string
}

function sign(certificate: string, app: string, args: string[], env: Record<string, string> = {}) {
  const scratch = tempDir('devot-sign-scratch-')
  const out = join(tempDir('devot-sign-out-'), 'out')
  const result = spawnSync(SCRIPT, [...args, app, out], {
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? '',
      RUNNER_TEMP: scratch,
      APPLE_CERTIFICATE: certificate,
      APPLE_CERTIFICATE_PASSWORD: PASSWORD,
      APPLE_SIGNING_IDENTITY: IDENTITY,
      ...env,
    },
    encoding: 'utf8',
  })
  return { status: result.status, output: result.stdout + result.stderr, out, scratch } as Run
}

function expectSignedCode(path: string) {
  const shown = signature(path)
  expect(shown).toMatch(new RegExp(`^Authority=${IDENTITY.replace(/[()]/g, '\\$&')}$`, 'm'))
  expect(shown).toMatch(/^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*runtime/m)
  expect(shown).toMatch(/^Timestamp=/m)
  expect(shown).not.toMatch(/Signature=adhoc/)
  expect(tool('codesign', ['-d', '--entitlements', '-', '--xml', path])).toBe('')
}

describe.skipIf(process.platform !== 'darwin')('signing on a Mac', () => {
  let certificate = ''
  let app = ''
  const before = () => keychainState()

  beforeAll(() => {
    certificate = throwawayCertificate()
    app = adHocApp()
  })

  it(
    'signs the app inside out with the hardened runtime, then makes the dmg and the updater bundle from it',
    () => {
      const state = before()
      const run = sign(certificate, app, ['--skip-notarization'])
      expect(run.output).toContain('Signed: Devot.dmg, Devot.app.tar.gz')
      expect(run.status).toBe(0)
      expect(keychainState()).toBe(state)
      expect(readdirSync(run.scratch)).toEqual([])
      for (const secret of [PASSWORD, certificate]) expect(run.output).not.toContain(secret)
      // The build's copy stays as it was.
      expect(signature(app)).toMatch(/Signature=adhoc/)

      const updater = join(run.out, 'Devot.app.tar.gz')
      const entries = tool('tar', ['-tzf', updater]).trim().split('\n')
      expect(entries.every((entry) => entry.startsWith('Devot.app/'))).toBe(true)
      expect(entries.filter((entry) => /(^|\/)\._/.test(entry))).toEqual([])
      const unpacked = tempDir('devot-sign-unpacked-')
      tool('tar', ['-xzf', updater, '-C', unpacked])
      const signed = join(unpacked, 'Devot.app')
      tool('codesign', ['--verify', '--deep', '--strict', signed])
      expectSignedCode(signed)
      expectSignedCode(join(signed, 'Contents', 'Frameworks', 'libextra.dylib'))

      const dmg = join(run.out, 'Devot.dmg')
      tool('codesign', ['--verify', '--strict', dmg])
      expect(signature(dmg)).toContain(`Authority=${IDENTITY}`)
      const mount = tempDir('devot-sign-mount-')
      tool('hdiutil', [
        'attach',
        '-quiet',
        '-readonly',
        '-nobrowse',
        '-noautoopen',
        '-mountpoint',
        mount,
        dmg,
      ])
      try {
        expect(readdirSync(mount).sort()).toEqual(['.VolumeIcon.icns', 'Applications', 'Devot.app'])
        expect(readlinkSync(join(mount, 'Applications'))).toBe('/Applications')
        expect(readFileSync(join(mount, '.VolumeIcon.icns'))).toEqual(
          readFileSync('src-tauri/icons/icon.icns'),
        )
        expect(tool('GetFileInfo', ['-a', mount]).trim()).toMatch(/C/)
        expect(
          tool('xattr', ['-px', 'com.apple.FinderInfo', join(mount, '.VolumeIcon.icns')]),
        ).toMatch(/^00 00 00 00 69 63 6E 43/)
        tool('codesign', ['--verify', '--deep', '--strict', join(mount, 'Devot.app')])
        expectSignedCode(join(mount, 'Devot.app'))
        expect(tool('diskutil', ['info', mount])).toMatch(/File System Personality:\s+HFS\+/)
      } finally {
        tool('hdiutil', ['detach', '-quiet', mount])
      }
    },
    TIMEOUT,
  )

  it(
    'stops with the notary log when Apple does not accept the app, and removes the API key',
    () => {
      const bin = tempDir('devot-sign-xcrun-')
      const seen = join(bin, 'seen')
      writeFileSync(
        join(bin, 'xcrun'),
        [
          '#!/bin/bash',
          'if [ "$1" != notarytool ]; then exec /usr/bin/xcrun "$@"; fi',
          'key=; args=("$@")',
          'for ((i = 0; i < ${#args[@]}; i++)); do [ "${args[$i]}" = --key ] && key=${args[$((i + 1))]}; done',
          `printf '%s\\n' "$key" > ${JSON.stringify(seen)}`,
          `cat "$key" >> ${JSON.stringify(seen)}`,
          'case $2 in',
          '  submit) echo \'{"id":"fake-submission-1","status":"Invalid","message":"Processing complete"}\' ;;',
          '  log) echo \'{"issues":[{"message":"The signature of the binary is invalid."}]}\' > "$4" ;;',
          'esac',
        ].join('\n'),
      )
      chmodSync(join(bin, 'xcrun'), 0o755)
      const state = before()
      const run = sign(certificate, app, [], {
        PATH: `${bin}:${process.env['PATH'] ?? ''}`,
        APPLE_API_KEY_P8: `-----BEGIN PRIVATE KEY-----\n${API_KEY_TEXT}\n-----END PRIVATE KEY-----`,
        APPLE_API_KEY_ID: 'FAKEKEY123',
        APPLE_API_ISSUER_ID: '00000000-0000-0000-0000-000000000000',
      })
      expect(run.status).toBe(1)
      expect(run.output).toMatch(
        /::error::E_SIGN_NOTARIZATION_REFUSED: Devot\.app ended as Invalid \(submission fake-submission-1\)/,
      )
      expect(run.output).toContain('The signature of the binary is invalid.')
      for (const secret of [PASSWORD, certificate, API_KEY_TEXT])
        expect(run.output).not.toContain(secret)

      const [keyPath, ...keyText] = readFileSync(seen, 'utf8').split('\n')
      expect(keyPath).toMatch(/\/AuthKey_FAKEKEY123\.p8$/)
      expect(keyText.join('\n')).toContain(API_KEY_TEXT)
      expect(existsSync(keyPath!)).toBe(false)
      expect(readdirSync(run.scratch)).toEqual([])
      expect(keychainState()).toBe(state)
      expect(existsSync(join(run.out, 'Devot.dmg'))).toBe(false)
    },
    TIMEOUT,
  )
})
