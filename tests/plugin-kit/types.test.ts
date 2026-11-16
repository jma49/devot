// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The kit's types (plugin-kit/types/index.d.ts) name every part of the `devot` global the runtime makes
// (src-tauri/plugin-frame/runtime.js), so a new call cannot ship without its type.

function runtimePaths(): string[] {
  new Function(readFileSync('src-tauri/plugin-frame/runtime.js', 'utf8'))()
  const api = (globalThis as unknown as { devot: Record<string, unknown> }).devot
  const paths: string[] = []
  for (const [area, value] of Object.entries(api)) {
    if (typeof value !== 'object' || value === null) paths.push(area)
    else for (const name of Object.keys(value)) paths.push(`${area}.${name}`)
  }
  return paths.sort()
}

function typedPaths(): string[] {
  const text = readFileSync('plugin-kit/types/index.d.ts', 'utf8')
  const body = text.slice(
    text.indexOf('export interface DevotApi {'),
    text.indexOf('export type DevotPermission'),
  )
  const paths: string[] = []
  let area: string | null = null
  for (const line of body.split('\n')) {
    const opened = /^ {2}readonly (\w+): \{$/.exec(line)
    const value = /^ {2}readonly (\w+): [^{]/.exec(line)
    const member = /^ {4}(\w+)\(/.exec(line)
    if (opened) area = opened[1]!
    else if (value) paths.push(value[1]!)
    else if (/^ {2}\}$/.test(line)) area = null
    else if (member && area) paths.push(`${area}.${member[1]}`)
  }
  return paths.sort()
}

describe('the plugin kit types', () => {
  it('cover the runtime’s whole API', () => {
    const runtime = runtimePaths()
    expect(runtime).toContain('note.insert')
    expect(typedPaths()).toEqual(runtime)
  })
})
