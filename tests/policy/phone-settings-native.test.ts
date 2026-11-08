import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const PHONE = 'src/renderer/src/phone'
const SETTINGS = 'src/renderer/src/settings'

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })

it('draws no Settings pane of the page on the iPhone', () => {
  const importers = sources(PHONE).filter((file) =>
    /from '(\.\.\/)+settings\/\w+Section'/.test(readFileSync(file, 'utf8')),
  )
  expect(importers).toStrictEqual([])
})

it('keeps no iPhone layout in the Settings panes', () => {
  const phoneOnly = sources(SETTINGS).filter((file) =>
    /from '\.\/onPhone'/.test(readFileSync(file, 'utf8')),
  )
  expect(phoneOnly).toStrictEqual([])
  expect(existsSync(join(SETTINGS, 'onPhone.ts'))).toBe(false)
})
