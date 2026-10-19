import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'

// Every UI command goes through ipc.ts, which turns a rejection (Rust sends its error code as a string)
// into an Error whose message is that code, so handlers, the log and crash reports get the code.
const ROOT = 'src/renderer'
const WRAPPER = 'src/renderer/src/ipc.ts'

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

it('runs commands only through the IPC wrapper', () => {
  const direct = sources(ROOT)
    .map((file) => relative('.', file))
    .filter((file) => file !== WRAPPER)
    .filter((file) => readFileSync(file, 'utf8').includes('@tauri-apps/api/core'))
  expect(direct).toEqual([])
  expect(readFileSync(WRAPPER, 'utf8')).toContain('@tauri-apps/api/core')
})
