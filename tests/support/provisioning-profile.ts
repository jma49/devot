import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from './temp-dirs'

const FIXTURE = 'tests/fixtures/signing/profile.plist'
const DAY = 86_400_000

let signer: { cert: string; key: string } | undefined

function throwawaySigner() {
  if (signer) return signer
  const dir = tempDir('devot-profile-signer-')
  const cert = join(dir, 'cert.pem')
  const key = join(dir, 'key.pem')
  const subject = '/CN=Devot profile fixture'
  execFileSync(
    '/usr/bin/openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      subject,
      '-keyout',
      key,
      '-out',
      cert,
    ],
    { stdio: 'pipe' },
  )
  signer = { cert, key }
  return signer
}

/**
 * A provisioning profile made from tests/fixtures/signing/profile.plist (team TESTTEAM01, App ID
 * io.github.jma49.devot.signtest), CMS-signed with a throwaway key as Apple's are. `edit` changes
 * the plist text first. Needs macOS's LibreSSL; returns the file's path.
 */
export function fixtureProfile(
  options: { expiresInDays?: number; edit?: (plist: string) => string } = {},
): string {
  const expires = new Date(Date.now() + (options.expiresInDays ?? 365) * DAY)
  const plist = readFileSync(FIXTURE, 'utf8').replace(
    'EXPIRATION_DATE',
    expires.toISOString().replace(/\.\d+Z$/, 'Z'),
  )
  const dir = tempDir('devot-profile-')
  const source = join(dir, 'profile.plist')
  const profile = join(dir, 'fixture.provisionprofile')
  writeFileSync(source, options.edit ? options.edit(plist) : plist)
  const { cert, key } = throwawaySigner()
  execFileSync('/usr/bin/openssl', [
    'smime',
    '-sign',
    '-binary',
    '-nodetach',
    '-outform',
    'DER',
    '-signer',
    cert,
    '-inkey',
    key,
    '-in',
    source,
    '-out',
    profile,
  ])
  return profile
}
