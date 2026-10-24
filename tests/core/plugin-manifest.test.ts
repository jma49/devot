import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { effectivePermissions, isPackagePath, parseManifest } from '../../src/core/plugins/manifest'

interface Cases {
  base: Record<string, unknown>
  valid: { name: string; patch: Record<string, unknown> }[]
  invalid: { name: string; patch: Record<string, unknown>; code: string }[]
}

const cases = JSON.parse(readFileSync('tests/fixtures/plugins/manifests.json', 'utf8')) as Cases

const patched = (patch: Record<string, unknown>) => {
  const out: Record<string, unknown> = structuredClone(cases.base)
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key]
    else out[key] = value
  }
  return out
}

const codeOf = (run: () => unknown) => {
  try {
    run()
    return 'accepted'
  } catch (e) {
    return (e as Error).message
  }
}

describe('plugin manifests (the cases Rust runs too)', () => {
  it.each(cases.valid)('accepts $name', ({ patch }) => {
    expect(codeOf(() => parseManifest(patched(patch)))).toBe('accepted')
  })

  it.each(cases.invalid)('refuses $name', ({ patch, code }) => {
    expect(codeOf(() => parseManifest(patched(patch)))).toBe(code)
  })
})

describe('parseManifest', () => {
  it('keeps the declared fields only and fills the optional ones', () => {
    const manifest = parseManifest({ ...patched({ description: null, author: null }), extra: 1 })
    expect(manifest).toEqual({
      id: 'com.example.word-count',
      name: 'Word Count',
      version: '1.2.0',
      apiVersion: 1,
      description: '',
      author: '',
      main: 'main.js',
      permissions: ['note.read', 'commands', 'menus', 'keymaps'],
      contributes: {
        commands: [{ id: 'count', title: 'Count Words' }],
        menus: [{ command: 'count' }],
        keymaps: [{ command: 'count', key: 'Mod+Shift+U' }],
        previewRenderers: [],
        importFormats: [],
        exportFormats: [],
      },
    })
  })

  it('refuses what is not an object', () => {
    for (const value of [null, [], 'x', 1]) {
      expect(codeOf(() => parseManifest(value))).toBe('E_PLUGIN_MANIFEST_INVALID')
    }
  })
})

describe('package paths', () => {
  it('takes plain relative parts only', () => {
    expect(isPackagePath('main.js')).toBe(true)
    expect(isPackagePath('a/b-c/d_e.f.js')).toBe(true)
    for (const bad of [
      '',
      '/a.js',
      'a//b.js',
      '../a.js',
      './a.js',
      'a/.b',
      '__devot/x.js',
      'a\\b',
    ]) {
      expect(isPackagePath(bad)).toBe(false)
    }
  })
})

describe('effectivePermissions', () => {
  it('is what the user granted and the manifest still asks for', () => {
    const manifest = parseManifest(patched({}))
    const granted = effectivePermissions({
      manifest,
      enabled: true,
      granted: ['note.read', 'note.edit', 'commands'],
    })
    expect([...granted].sort()).toEqual(['commands', 'note.read'])
  })
})
