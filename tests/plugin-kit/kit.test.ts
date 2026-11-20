import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { run, type Io } from '../../plugin-kit/src/cli'
import { PACKAGE_LIMITS, readPackage } from '../../plugin-kit/src/package'
import { zip } from '../../plugin-kit/src/zip'
import { THEME_LIMITS } from '../../src/core/plugins/themeFile'
import { tempDir } from '../support/temp-dirs'

const MANIFEST = {
  id: 'com.example.kit',
  name: 'Kit',
  version: '1.0.0',
  apiVersion: 2,
  main: 'main.js',
  permissions: ['commands'],
  contributes: { commands: [{ id: 'go', title: 'Go' }] },
}

function folder(files: Record<string, string>): string {
  const root = tempDir('devot-kit-')
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

const plugin = (more: Record<string, string> = {}) =>
  folder({ 'devot-plugin.json': JSON.stringify(MANIFEST), 'main.js': '', ...more })

function io(cwd: string) {
  const out: string[] = []
  const err: string[] = []
  const given: Io = { cwd, out: (l) => out.push(l), err: (l) => err.push(l) }
  return { given, out, err }
}

const codeOf = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code
  }
  return null
}

/** The entries of a `.zip` the kit wrote, read through its central directory. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = bytes.length - 22
  expect(view.getUint32(end, true)).toBe(0x06054b50)
  const count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)
  const out = new Map<string, string>()
  for (let i = 0; i < count; i += 1) {
    expect(view.getUint32(at, true)).toBe(0x02014b50)
    const packed = view.getUint32(at + 20, true)
    const nameLength = view.getUint16(at + 28, true)
    const local = view.getUint32(at + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength))
    const start = local + 30 + view.getUint16(local + 26, true)
    out.set(name, inflateRawSync(bytes.subarray(start, start + packed)).toString('utf8'))
    at += 46 + nameLength
  }
  return out
}

describe('readPackage', () => {
  it('reads a plugin as Devot would install it, without hidden or development files', () => {
    const root = plugin({
      'lib/util.js': 'x',
      '.DS_Store': '',
      'package.json': '{}',
      'node_modules/a/index.js': '',
      'old.zip': '',
    })
    const read = readPackage(root)
    expect(read.manifest.id).toBe('com.example.kit')
    expect([...read.files.keys()]).toEqual(['devot-plugin.json', 'lib/util.js', 'main.js'])
  })

  it('refuses what Devot refuses, with its codes', () => {
    expect(codeOf(() => readPackage(folder({ 'main.js': '' })))).toBe('E_PLUGIN_MANIFEST_MISSING')
    expect(codeOf(() => readPackage(folder({ 'devot-plugin.json': '{' })))).toBe(
      'E_PLUGIN_MANIFEST_INVALID',
    )
    expect(
      codeOf(() =>
        readPackage(
          folder({ 'devot-plugin.json': JSON.stringify({ ...MANIFEST, apiVersion: 99 }) }),
        ),
      ),
    ).toBe('E_PLUGIN_API_TOO_NEW')
    expect(
      codeOf(() => readPackage(folder({ 'devot-plugin.json': JSON.stringify(MANIFEST) }))),
    ).toBe('E_PLUGIN_MAIN_MISSING')
    expect(codeOf(() => readPackage(plugin({ 'a b.js': '' })))).toBe('E_PLUGIN_PACKAGE_INVALID')
    expect(codeOf(() => readPackage(plugin({ '__devot/x.js': '' })))).toBe(
      'E_PLUGIN_PACKAGE_INVALID',
    )
    expect(codeOf(() => readPackage(plugin({ 'a/b/c/d/e/f/g/h/i.js': '' })))).toBe(
      'E_PLUGIN_PACKAGE_INVALID',
    )
    const linked = plugin()
    symlinkSync(join(linked, 'main.js'), join(linked, 'other.js'))
    expect(codeOf(() => readPackage(linked))).toBe('E_PLUGIN_PACKAGE_LINK')
    const large = plugin({ 'big.js': 'x'.repeat(PACKAGE_LIMITS.fileBytes + 1) })
    expect(codeOf(() => readPackage(large))).toBe('E_PLUGIN_PACKAGE_TOO_LARGE')
  })

  it('keeps the limits Rust installs by', () => {
    const rust = (file: string, name: string) => {
      const found = new RegExp(`const ${name}: \\w+ = ([^;]+);`).exec(readFileSync(file, 'utf8'))
      return Function(`return ${found![1]!.replaceAll('_', '')}`)() as number
    }
    const pkg = 'src-tauri/src/plugins/package.rs'
    const manifest = 'src-tauri/src/plugins/manifest.rs'
    expect(PACKAGE_LIMITS).toEqual({
      files: rust(pkg, 'MAX_FILES'),
      fileBytes: rust(pkg, 'MAX_FILE_BYTES'),
      totalBytes: rust(pkg, 'MAX_TOTAL_BYTES'),
      depth: rust(manifest, 'DEPTH_MAX'),
      manifestBytes: rust(manifest, 'MAX_BYTES'),
    })
    expect(THEME_LIMITS).toEqual({
      bytes: rust(pkg, 'THEME_MAX_BYTES'),
      colors: rust(pkg, 'THEME_COLORS_MAX'),
    })
  })

  it('reads the theme files a plugin lists, and refuses one Devot cannot draw', () => {
    const themed = (files: Record<string, string>) =>
      folder({
        'devot-plugin.json': JSON.stringify({
          ...MANIFEST,
          permissions: ['commands', 'themes'],
          contributes: {
            ...MANIFEST.contributes,
            themes: [{ id: 'dusk', title: 'Dusk', appearance: 'dark', path: 'themes/dusk.json' }],
          },
        }),
        'main.js': '',
        ...files,
      })
    const good = JSON.stringify({ colors: { 'surface-editor': '#101820' } })
    expect(readPackage(themed({ 'themes/dusk.json': good })).files.has('themes/dusk.json')).toBe(
      true,
    )
    for (const files of [
      {},
      { 'themes/dusk.json': '{' },
      { 'themes/dusk.json': JSON.stringify({ colors: {} }) },
      { 'themes/dusk.json': JSON.stringify({ colors: { 'surface-editor': 'red' } }) },
      { 'themes/dusk.json': JSON.stringify({ colors: { Surface: '#101820' } }) },
    ]) {
      expect(codeOf(() => readPackage(themed(files)))).toBe('E_PLUGIN_THEME_INVALID')
    }
  })
})

describe('zip', () => {
  it('stores each file whole, in name order, the same bytes every time', () => {
    const files = new Map([
      ['main.js', new TextEncoder().encode('devot.commands.handle("go", () => null)')],
      ['devot-plugin.json', new TextEncoder().encode('{}')],
      ['lib/été.js', new TextEncoder().encode('')],
    ])
    const packed = zip(files)
    expect([...unzip(packed)]).toEqual([
      ['devot-plugin.json', '{}'],
      ['lib/été.js', ''],
      ['main.js', 'devot.commands.handle("go", () => null)'],
    ])
    expect(zip(files)).toEqual(packed)
  })

  it('matches the archive Rust’s install test reads', () => {
    const fixture = readFileSync('tests/fixtures/plugins/kit-packed.zip')
    const packed = zip(readPackage('tests/fixtures/plugins/kit-packed').files)
    expect(unzip(packed)).toEqual(unzip(fixture))
  })
})

describe('devot-plugin', () => {
  it('starts a plugin that validates and packs', () => {
    const cwd = tempDir('devot-kit-')
    const made = io(cwd)
    expect(run(['new', 'word-tools'], made.given)).toBe(0)
    const read = readPackage(join(cwd, 'word-tools'))
    expect(read.manifest).toMatchObject({
      id: 'com.example.word-tools',
      name: 'Word Tools',
      apiVersion: 3,
      contributes: { slashMenu: [{ command: 'upper-case' }] },
    })
    const checked = io(cwd)
    expect(run(['validate', 'word-tools'], checked.given)).toBe(0)
    expect(checked.out[0]).toBe('com.example.word-tools 0.1.0: valid for plugin API 3, 3 files')
    const packed = io(cwd)
    expect(run(['pack', 'word-tools'], packed.given)).toBe(0)
    const zipped = unzip(readFileSync(join(cwd, 'com.example.word-tools-0.1.0.zip')))
    expect([...zipped.keys()]).toEqual(['README.md', 'devot-plugin.json', 'main.js'])
  })

  it('takes an id and name, and never writes into a folder with files', () => {
    const cwd = tempDir('devot-kit-')
    expect(run(['new', 'x', '--id', 'org.acme.tool', '--name', 'Acme Tool'], io(cwd).given)).toBe(0)
    expect(readPackage(join(cwd, 'x')).manifest).toMatchObject({
      id: 'org.acme.tool',
      name: 'Acme Tool',
    })
    const again = io(cwd)
    expect(run(['new', 'x'], again.given)).toBe(1)
    expect(again.err[0]).toMatch(/^E_KIT_FOLDER_NOT_EMPTY /)
  })

  it('reports a refused plugin by its code, and usage for anything else', () => {
    const bad = io(folder({ 'main.js': '' }))
    expect(run(['validate'], bad.given)).toBe(1)
    expect(bad.err).toEqual(['E_PLUGIN_MANIFEST_MISSING'])
    const lost = io(tempDir('devot-kit-'))
    expect(run(['publish'], lost.given)).toBe(2)
    expect(lost.err[0]).toMatch(/^Usage:/)
  })
})
