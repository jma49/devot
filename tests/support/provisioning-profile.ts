import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from './temp-dirs'

const FIXTURE = 'tests/fixtures/signing/profile.plist'
const DAY = 86_400_000

let signer: { cert: string; key: string; der: string } | undefined

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
  const der = Buffer.from(
    readFileSync(cert, 'utf8').replace(/-----[A-Z ]+-----|\s/g, ''),
    'base64',
  ).toString('base64')
  signer = { cert, key, der }
  return signer
}

/** The SHA-1 of a DER certificate given in base64, as `security find-identity` prints it. */
export function certificateSha1(der: string): string {
  return createHash('sha1').update(Buffer.from(der, 'base64')).digest('hex').toUpperCase()
}

/** The certificate a fixture profile holds unless `certificates` says otherwise. */
export function fixtureCertificate(): string {
  return throwawaySigner().der
}

/**
 * A provisioning profile made from tests/fixtures/signing/profile.plist (team TESTTEAM01, App ID
 * io.github.jma49.devot.signtest), CMS-signed with a throwaway key as Apple's are. It holds
 * `certificates` (base64 DER; by default fixtureCertificate()) as its DeveloperCertificates.
 * `edit` changes the plist text first. Needs macOS's LibreSSL; returns the file's path.
 */
export function fixtureProfile(
  options: {
    expiresInDays?: number
    certificates?: string[]
    edit?: (plist: string) => string
  } = {},
): string {
  const expires = new Date(Date.now() + (options.expiresInDays ?? 365) * DAY)
  const certificates = options.certificates ?? [fixtureCertificate()]
  const plist = readFileSync(FIXTURE, 'utf8')
    .replace('EXPIRATION_DATE', expires.toISOString().replace(/\.\d+Z$/, 'Z'))
    .replace(
      '\t\t<data>AAAA</data>\n',
      certificates.map((der) => `\t\t<data>${der}</data>\n`).join(''),
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
