import { spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  channelOf,
  compareVersions,
  feedChannels,
  replacesFeed,
  scryptParams,
  signedVersion,
  signFile,
  signingKey,
  updateFeed,
  verifySignature,
  versionFromTag,
  withCargoVersion,
  withPackageVersion,
} from '../../scripts/release/release'
import { tempDir } from '../support/temp-dirs'

const root = join(import.meta.dirname, '../..')

describe('release versions', () => {
  it('takes the version from a release tag', () => {
    expect(versionFromTag('v0.9.1-beta1')).toBe('0.9.1-beta1')
    expect(versionFromTag('v0.10.12-beta9')).toBe('0.10.12-beta9')
    expect(versionFromTag('v1.0.0')).toBe('1.0.0')
  })

  it('refuses any other tag', () => {
    for (const tag of [
      '0.9.1-beta1',
      'v0.9.1-beta',
      'v0.9.1-rc1',
      'v0.9-beta1',
      'v0.9.1-beta1 ',
      'v01.9.1',
      'v0.9.01-beta1',
      'v0.9.1-beta0',
      'v0.9.1-beta01',
      // One digit only: `beta10` would sort before `beta2`.
      'v0.9.1-beta10',
      'v0.9.0-beta.1',
      'updater',
      '',
    ])
      expect(() => versionFromTag(tag)).toThrow('E_RELEASE_TAG_INVALID')
  })

  it('puts a prerelease on the beta channel', () => {
    expect(channelOf('0.9.1-beta1')).toBe('beta')
    expect(channelOf('1.0.0')).toBe('stable')
  })

  it('writes the version into the package table of Cargo.toml only', () => {
    const toml = [
      '[package]',
      'name = "devot"',
      'version = "0.0.0"',
      '',
      '[dependencies]',
      'version = "9"',
    ].join('\n')
    expect(withCargoVersion(toml, '0.3.0-beta.1').split('\n')).toEqual([
      '[package]',
      'name = "devot"',
      'version = "0.3.0-beta.1"',
      '',
      '[dependencies]',
      'version = "9"',
    ])
    expect(() => withCargoVersion('[package]\nname = "x"\n[lib]\nversion = "1"', '1.0.0')).toThrow(
      'E_RELEASE_CARGO_VERSION_MISSING',
    )
    const real = readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8')
    expect(withCargoVersion(real, '0.3.0-beta.1')).toContain('\nversion = "0.3.0-beta.1"\n')
  })

  it('writes the version into package.json', () => {
    const json = '{\n  "name": "devot",\n  "version": "0.0.0"\n}\n'
    expect(withPackageVersion(json, '1.2.3')).toBe(
      '{\n  "name": "devot",\n  "version": "1.2.3"\n}\n',
    )
    expect(() => withPackageVersion('{}', '1.2.3')).toThrow('E_RELEASE_PACKAGE_VERSION_MISSING')
  })
})

describe('feed order', () => {
  it('orders versions as the updater does', () => {
    const sorted = [
      '0.3.0-beta.1',
      '0.3.0-beta.2',
      '0.3.0-beta.10',
      '0.3.0',
      '0.9.0-beta.1',
      '0.9.1-beta1',
      '0.9.1-beta2',
      '0.9.1',
      '0.9.2-beta1',
      '1.0.0',
    ]
    for (let i = 1; i < sorted.length; i++) {
      expect(compareVersions(sorted[i - 1]!, sorted[i]!)).toBe(-1)
      expect(compareVersions(sorted[i]!, sorted[i - 1]!)).toBe(1)
    }
    expect(compareVersions('0.9.1-beta2', '0.9.1-beta2')).toBe(0)
    expect(() => compareVersions('0.3', '0.3.0')).toThrow('E_RELEASE_VERSION_INVALID')
  })

  it('lets only a newer release replace the feed', () => {
    const feed = JSON.stringify({ version: '0.9.1-beta1' })
    expect(replacesFeed('0.9.1-beta2', feed)).toBe(true)
    expect(replacesFeed('0.9.1-beta1', feed)).toBe(false)
    expect(replacesFeed('0.9.0', feed)).toBe(false)
    const old = JSON.stringify({ version: '0.9.0-beta.1' })
    expect(replacesFeed('0.9.1-beta1', old)).toBe(true)
    expect(replacesFeed('0.8.9-beta1', old)).toBe(false)
    expect(replacesFeed('0.3.0-beta.1', '')).toBe(true)
    expect(replacesFeed('0.3.0-beta.1', '{}')).toBe(true)
    expect(replacesFeed('0.3.0-beta.1', '{"version":"latest"}')).toBe(true)
  })

  it('replaces the feed of its own version rebuilt with another signature', () => {
    const feed = JSON.stringify({
      version: '1.0.6',
      platforms: { 'darwin-aarch64': { signature: 'old', url: 'u' } },
    })
    expect(replacesFeed('1.0.6', feed, 'new')).toBe(true)
    expect(replacesFeed('1.0.6', feed, 'old')).toBe(false)
    expect(replacesFeed('1.0.6', feed)).toBe(false)
    expect(replacesFeed('1.0.7', feed, 'old')).toBe(true)
    expect(replacesFeed('1.0.5', feed, 'new')).toBe(false)
  })

  it('puts a stable release in the beta feed too', () => {
    // A beta install reads beta.json and gets the newest build of either kind; a stable install never gets a beta.
    expect(feedChannels('1.0.0')).toEqual(['stable', 'beta'])
    expect(feedChannels('1.0.0-beta3')).toEqual(['beta'])
    expect(replacesFeed('1.0.0', JSON.stringify({ version: '1.0.0-beta5' }))).toBe(true)
    expect(replacesFeed('1.0.0', JSON.stringify({ version: '1.0.1-beta1' }))).toBe(false)
  })

  it('prints the feeds a tag writes, one per line', () => {
    const feeds = (tag: string) =>
      spawnSync(process.execPath, [join(root, 'scripts/release/release.ts'), 'feeds', tag], {
        encoding: 'utf8',
      })
    expect(feeds('v1.0.0').stdout).toBe('stable\nbeta\n')
    expect(feeds('v1.0.1-beta2').stdout).toBe('beta\n')
    const bad = feeds('v1.0')
    expect(bad.status).toBe(1)
    expect(bad.stderr).toContain('E_RELEASE_TAG_INVALID')
  })
})

describe('update feed', () => {
  const input = {
    version: '0.9.1-beta2',
    notes: '- #166 Automatic updates\n',
    date: new Date(Date.UTC(2026, 9, 18, 9)),
    url: 'https://github.com/jma49/devot/releases/download/v0.9.1-beta2/Devot.app.tar.gz',
    signature: 'dW50cnVzdGVkIGNvbW1lbnQ6\n',
  }

  it('lists the Apple Silicon bundle in the format the updater reads', () => {
    expect(updateFeed(input)).toEqual({
      version: '0.9.1-beta2',
      notes: '- #166 Automatic updates',
      pub_date: '2026-10-18T09:00:00.000Z',
      platforms: {
        'darwin-aarch64': { signature: 'dW50cnVzdGVkIGNvbW1lbnQ6', url: input.url },
      },
    })
  })

  it('refuses a feed without a signature or with a plain-HTTP bundle', () => {
    expect(() => updateFeed({ ...input, signature: ' \n' })).toThrow(
      'E_RELEASE_FEED_SIGNATURE_MISSING',
    )
    expect(() => updateFeed({ ...input, url: 'http://example.com/Devot.app.tar.gz' })).toThrow(
      'E_RELEASE_FEED_URL_INVALID',
    )
  })

  it('writes the feed file from the command line', () => {
    const dir = tempDir('devot-release-')
    const sig = join(dir, 'Devot.app.tar.gz.sig')
    const notes = join(dir, 'notes.md')
    const out = join(dir, 'beta.json')
    writeFileSync(sig, input.signature)
    writeFileSync(notes, input.notes)
    const run = spawnSync(
      process.execPath,
      [
        join(root, 'scripts/release/release.ts'),
        'feed',
        'v0.9.1-beta2',
        input.url,
        sig,
        notes,
        out,
      ],
      { encoding: 'utf8' },
    )
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    const feed = JSON.parse(readFileSync(out, 'utf8')) as ReturnType<typeof updateFeed>
    expect(feed.version).toBe('0.9.1-beta2')
    expect(feed.platforms['darwin-aarch64'].url).toBe(input.url)
    const bad = spawnSync(
      process.execPath,
      [join(root, 'scripts/release/release.ts'), 'feed', 'v0.3', input.url, sig, notes, out],
      { encoding: 'utf8' },
    )
    expect(bad.status).toBe(1)
    expect(bad.stderr).toContain('E_RELEASE_TAG_INVALID')
  })
})

describe('update signatures', () => {
  function keyPair(id: number) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const keyId = Buffer.alloc(8)
    keyId.writeUInt32LE(id)
    const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url')
    const line = Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64')
    const pub = Buffer.from(`untrusted comment: minisign public key\n${line}\n`).toString('base64')
    return { pub, privateKey, keyId }
  }

  /** A prehashed minisign signature, base64 whole, as Tauri writes it. */
  function signature(file: Buffer, privateKey: KeyObject, keyId: Buffer, trusted = 'file:x') {
    const body = sign(null, createHash('blake2b512').update(file).digest(), privateKey)
    const global = sign(null, Buffer.concat([body, Buffer.from(trusted)]), privateKey)
    const text = [
      'untrusted comment: signature from tauri secret key',
      Buffer.concat([Buffer.from('ED'), keyId, body]).toString('base64'),
      `trusted comment: ${trusted}`,
      global.toString('base64'),
      '',
    ].join('\n')
    return Buffer.from(text).toString('base64')
  }

  const file = Buffer.from('Devot.app.tar.gz')

  it('takes a signature made with the secret key of the public key', () => {
    const { pub, privateKey, keyId } = keyPair(1)
    expect(() => verifySignature(file, signature(file, privateKey, keyId), pub)).not.toThrow()
  })

  it('refuses a signature from another key, or of another file', () => {
    const one = keyPair(1)
    const other = keyPair(2)
    const sig = signature(file, one.privateKey, one.keyId)
    expect(() => verifySignature(file, sig, other.pub)).toThrow('E_RELEASE_SIGNATURE_KEY_MISMATCH')
    // The same key ID, another key: the signature itself fails.
    const twin = keyPair(1)
    expect(() => verifySignature(file, sig, twin.pub)).toThrow('E_RELEASE_SIGNATURE_INVALID')
    expect(() => verifySignature(Buffer.from('other'), sig, one.pub)).toThrow(
      'E_RELEASE_SIGNATURE_INVALID',
    )
  })

  it('refuses a trusted comment changed after signing', () => {
    const { pub, privateKey, keyId } = keyPair(1)
    const text = Buffer.from(signature(file, privateKey, keyId), 'base64').toString()
    const changed = Buffer.from(text.replace('file:x', 'file:y')).toString('base64')
    expect(() => verifySignature(file, changed, pub)).toThrow('E_RELEASE_SIGNATURE_INVALID')
  })

  it('refuses what is not a minisign key or signature', () => {
    const { pub, privateKey, keyId } = keyPair(1)
    const sig = signature(file, privateKey, keyId)
    expect(() => verifySignature(file, sig, '')).toThrow('E_RELEASE_PUBKEY_MALFORMED')
    expect(() => verifySignature(file, 'bm9wZQ==', pub)).toThrow('E_RELEASE_SIGNATURE_MALFORMED')
  })
})

describe('signing the updater bundle', () => {
  // Test keys from `tauri signer generate --ci`, one with the password 'test password', one with
  // an empty one. They sign nothing outside these tests.
  const withPassword = {
    key: 'dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5ClJXUlRZMEl5OGt5Sng0cllDbjByVzcvdlZTNFRLbmY4Y2V5cTV2c1MyUHhpTE4xbmlwY0FBQkFBQUFBQUFBQUFBQUlBQUFBQTRoWmx6ZmZrTHcyM0VBaHljWmpHN3dpTjFVMUs2OEp6ZjZ1NnNCNTE5VW5QeFpYVlNQVG9PYWlNWjFydjcvVWpMZnl0WUNjdExPaWRPQmJvc1JDTWJXT3VQLy95RERHNGtnMzRpUVNnUTlscDRUcHVvcWVoMDRwWUpzMkZrUzMvQlE0T3A4MW1xeVU9Cg==',
    pub: 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDhGM0NFQTM1MDBGNkQ2NTMKUldSVDF2WUFOZW84ajRzTWpJYzRZYmpCUnd4bDQvUTNMaUtocFVhd3d1bnlFeWNxWG1GcEVXZTgK',
  }
  const emptyPassword = {
    key: 'dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5ClJXUlRZMEl5MWFKT3VUSWhtRHM4Sk4wckh4a21NN3FwNWpUQkhWTnJ3ekRUTjVRV3RqVUFBQkFBQUFBQUFBQUFBQUlBQUFBQVYyM2VNV2V1MDBUWWdHaVZNY01OUGRwTlNxYlZ0RDY2aFhNc1ozOTZLWlY1TTgwa05HNjlJb3BIWlNSS0gxTWcvcXI2TEFqaGxjUzdLaGg4WkNxRVdQQjEyczFUMFhWR0g4NUFTdDhPMDg2aElmSGx6TkpFZWRwVVk2NWUyVUtMS0xNeG1Wdzh6S0U9Cg==',
    pub: 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEMxOUNDNjZBNzkyNUY0Q0QKUldUTjlDVjVhc2Fjd1Z2QVJQcDNZNkFiS1dxVmI0ZUNySnVSVVVFU0tqS0drV01YMWhjNGpzUzAK',
  }
  // `tauri signer sign` of 'hello devot' with the first key.
  const tauriSignature =
    'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSVDF2WUFOZW84ajFwckFEQ0Q2d0hIZkM2QytSTU9OVkZlS01abTJ1K3lNRnBJT1VFS2xWcWMzNmxwR0IwcDgvcnZKK1JKYTJyZjVDZXpXT1YwNXVWQ1o0aW9lUU15cVFJPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyNDQzMzE5CWZpbGU6ZGF0YS5iaW4KODg3Q2IxUXhGVnQvSGhIYUpINlBrUUVvL28xT0hDSnl0RlJYSTE1SVhzd1F1OE50S0lXRUlpb2NMVUFRcDNNb1dkRlV0dDhONWpSSmNLZzNPbkFvRGc9PQo='
  const file = Buffer.from('hello devot')
  const date = new Date('2026-10-19T00:00:00Z')

  it('derives the scrypt parameters minisign uses for its default limits', () => {
    expect(scryptParams(1_048_576, 33_554_432)).toEqual({
      N: 32768,
      r: 8,
      p: 1,
    })
    expect(() => scryptParams(1_048_576, 2 * 1_073_741_824)).toThrow(
      'E_RELEASE_SECRET_KEY_MALFORMED',
    )
  })

  it('signs with a key Tauri made, so its public key takes the signature', () => {
    for (const [{ key, pub }, password] of [
      [withPassword, 'test password'],
      [emptyPassword, ''],
    ] as const) {
      const sig = signFile(file, 'Devot.app.tar.gz', '0.9.2-beta1', signingKey(key, password), date)
      const trusted = verifySignature(file, sig, pub)
      expect(trusted).toBe('timestamp:1792368000\tfile:Devot.app.tar.gz\tversion:0.9.2-beta1')
      expect(signedVersion(trusted)).toBe('0.9.2-beta1')
    }
  })

  it('reads a signature Tauri wrote, which records no version', () => {
    expect(signedVersion(verifySignature(file, tauriSignature, withPassword.pub))).toBeUndefined()
  })

  it('refuses a wrong password or what is not a secret key', () => {
    expect(() => signingKey(withPassword.key, 'wrong')).toThrow('E_RELEASE_SECRET_KEY_PASSWORD')
    expect(() => signingKey(withPassword.pub, '')).toThrow('E_RELEASE_SECRET_KEY_MALFORMED')
  })

  it('refuses a name or version that would break the trusted comment', () => {
    const signer = signingKey(emptyPassword.key, '')
    expect(() => signFile(file, 'a\tb', '1.0.0', signer, date)).toThrow(
      'E_RELEASE_SIGN_COMMENT_INVALID',
    )
  })

  it('signs from the command line and checks the signed version', () => {
    const dir = tempDir('devot-release-sign-')
    const bundle = join(dir, 'Devot_0.9.2-beta1_aarch64.app.tar.gz')
    const out = `${bundle}.sig`
    writeFileSync(bundle, file)
    const script = join(root, 'scripts/release/release.ts')
    const env = {
      ...process.env,
      TAURI_SIGNING_PRIVATE_KEY: withPassword.key,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'test password',
    }
    const signed = spawnSync('node', [script, 'sign', 'v0.9.2-beta1', bundle, out], {
      encoding: 'utf8',
      env,
    })
    expect(signed.stderr).toBe('')
    expect(signed.status).toBe(0)
    const check = (tag: string) =>
      spawnSync('node', [script, 'verify-signature', bundle, out, withPassword.pub, tag], {
        encoding: 'utf8',
      })
    expect(check('v0.9.2-beta1').status).toBe(0)
    const other = check('v0.9.3-beta1')
    expect(other.status).toBe(1)
    expect(other.stderr).toContain('E_RELEASE_SIGNED_VERSION_MISMATCH')
  })
})
