import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

// A closing dialog leaves an open copy fading in the page (dialogMotion.ts); a query for open dialogs
// that counts it drops shortcuts and keys until the copy goes. `sheetOpen` leaves copies out.
const UI_ROOT = 'src/renderer/src'

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

it('asks whether a sheet is up only through sheetOpen', () => {
  const code = files(UI_ROOT).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
  const queries = code.filter((f) => readFileSync(f, 'utf8').includes("'dialog[open]"))
  expect(queries).toEqual([join(UI_ROOT, 'commands', 'dispatch.ts')])
  expect(readFileSync(queries[0] ?? '', 'utf8')).toContain("'dialog[open]:not([data-closing])'")
})
