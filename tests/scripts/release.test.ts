import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  channelOf,
  compareVersions,
  replacesFeed,
  updateFeed,
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
