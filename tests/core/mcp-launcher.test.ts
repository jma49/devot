// The launcher the extension and the directory plugin carry (src-tauri/mcp/devot-mcp.sh), run for
// real. Its fixed places are swapped for temporary ones, so a Devot on this machine never runs.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from '../support/temp-dirs'

const LAUNCHER = readFileSync('src-tauri/mcp/devot-mcp.sh', 'utf8')

function replacedOnce(text: string, from: string, to: string): string {
  expect(text.split(from)).toHaveLength(2)
  return text.replace(from, () => to)
}

function fakeApp(at: string): string {
  const macos = join(at, 'Contents/MacOS')
  mkdirSync(macos, { recursive: true })
  const binary = join(macos, 'devot')
  writeFileSync(binary, `#!/bin/sh\necho "ran ${at} $*"\n`)
  chmodSync(binary, 0o755)
  return at
}

function run(options: { spotlight?: string[]; arg?: string; home?: string } = {}) {
  const root = tempDir('devot-launcher-')
  const home = options.home ?? join(root, 'home')
  mkdirSync(home, { recursive: true })
  const mdfind = join(root, 'mdfind')
  writeFileSync(
    mdfind,
    `#!/bin/sh\nprintf '%s\\n' ${(options.spotlight ?? []).map((p) => `'${p}'`).join(' ')}\n`,
  )
  chmodSync(mdfind, 0o755)
  let script = replacedOnce(
    LAUNCHER,
    ' /Applications/Devot.app ',
    ` ${join(root, 'Applications/Devot.app')} `,
  )
  script = replacedOnce(script, '/usr/bin/mdfind', mdfind)
  const path = join(root, 'devot-mcp.sh')
  writeFileSync(path, script)
  const result = spawnSync('/bin/sh', [path, ...(options.arg ? [options.arg] : [])], {
    env: { HOME: home, PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
  })
  return result
}

describe('the MCP launcher', () => {
  it('runs the bridge of the Devot it was given', () => {
    const app = fakeApp(join(tempDir('devot-given-'), 'Devot.app'))
    const result = run({ arg: app })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`ran ${app} --cli mcp\n`)
  })

  it('finds Devot in ~/Applications', () => {
    const home = tempDir('devot-home-')
    const app = fakeApp(join(home, 'Applications/Devot.app'))
    const result = run({ home })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`ran ${app} --cli mcp\n`)
  })

  it('skips Spotlight hits that are not a Mac app, such as an iOS build', () => {
    const elsewhere = tempDir('devot-elsewhere-')
    const ios = join(elsewhere, 'ios/Devot.app')
    mkdirSync(ios, { recursive: true })
    const app = fakeApp(join(elsewhere, 'Tools/Devot.app'))
    const result = run({ spotlight: [ios, app] })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`ran ${app} --cli mcp\n`)
  })

  it('says Devot is missing, with its code and what to do, and keeps stdout empty', () => {
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^E_MCP_APP_NOT_FOUND /)
    expect(result.stderr).toContain('https://devot.online')
  })
})
