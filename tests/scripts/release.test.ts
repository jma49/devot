import { spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  channelOf,
  compareVersions,
  replacesFeed,
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
    expect(versionFromTag('v0.3.0-beta.1')).toBe('0.3.0-beta.1')
    expect(versionFromTag('v0.10.2-beta.12')).toBe('0.10.2-beta.12')
    expect(versionFromTag('v1.0.0')).toBe('1.0.0')
  })

  it('refuses any other tag', () => {
    for (const tag of [
      '0.3.0-beta.1',
      'v0.3.0-beta',
      'v0.3.0-rc.1',
      'v0.3-beta.1',
      'v0.3.0-beta.1 ',
      'v01.3.0',
      'v0.3.0-beta.01',
      'v0.2.1-beta',
      'updater',
      '',
    ])
      expect(() => versionFromTag(tag)).toThrow('E_RELEASE_TAG_INVALID')
  })

  it('puts a prerelease on the beta channel', () => {
    expect(channelOf('0.3.0-beta.1')).toBe('beta')
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
    // The real file has a version to replace.
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
      '0.4.0-beta.1',
      '1.0.0',
    ]
    for (let i = 1; i < sorted.length; i++) {
      expect(compareVersions(sorted[i - 1]!, sorted[i]!)).toBe(-1)
      expect(compareVersions(sorted[i]!, sorted[i - 1]!)).toBe(1)
    }
    expect(compareVersions('0.3.0-beta.2', '0.3.0-beta.2')).toBe(0)
    expect(() => compareVersions('0.3', '0.3.0')).toThrow('E_RELEASE_VERSION_INVALID')
  })

  it('lets only a newer release replace the feed', () => {
    const feed = JSON.stringify({ version: '0.4.0-beta.1' })
    expect(replacesFeed('0.4.0-beta.2', feed)).toBe(true)
    expect(replacesFeed('0.4.0-beta.1', feed)).toBe(false)
    expect(replacesFeed('0.3.0-beta.9', feed)).toBe(false)
    // No feed yet, an empty file, or one without a version.
    expect(replacesFeed('0.3.0-beta.1', '')).toBe(true)
    expect(replacesFeed('0.3.0-beta.1', '{}')).toBe(true)
    expect(replacesFeed('0.3.0-beta.1', '{"version":"latest"}')).toBe(true)
  })
})

describe('update feed', () => {
  const input = {
    version: '0.3.0-beta.2',
    notes: '- #166 Automatic updates\n',
    date: new Date(Date.UTC(2026, 9, 18, 9)),
    url: 'https://github.com/jma49/devot/releases/download/v0.3.0-beta.2/Devot.app.tar.gz',
    signature: 'dW50cnVzdGVkIGNvbW1lbnQ6\n',
  }

  it('lists the Apple Silicon bundle in the format the updater reads', () => {
    expect(updateFeed(input)).toEqual({
      version: '0.3.0-beta.2',
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
        'v0.3.0-beta.2',
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
    expect(feed.version).toBe('0.3.0-beta.2')
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
  /** A key pair and its public key as Tauri writes it (base64 of the minisign file). */
  function keyPair(id: number) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const keyId = Buffer.alloc(8)
    keyId.writeUInt32LE(id)
    const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url')
    const line = Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64')
    const pub = Buffer.from(`untrusted comment: minisign public key\n${line}\n`).toString('base64')
    return { pub, privateKey, keyId }
  }

  /** A .sig as Tauri writes it: a prehashed minisign signature, base64 whole. */
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
