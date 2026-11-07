import { existsSync, readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { listFiles } from '../support/git-files'

const STYLESHEETS = [
  'src/renderer/src/app.css',
  'src/renderer/src/preview/content.css',
  'src/renderer/src/phone/phone.css',
]

const offenders = (files: string[], pattern: RegExp) =>
  files.filter((file) => existsSync(file) && pattern.test(readFileSync(file, 'utf8')))

it('keys no stylesheet rule on an interface style attribute', () => {
  expect(offenders(STYLESHEETS, /data-sidebar-material/)).toEqual([])
})

it('names no interface style setting in the app or its window code', () => {
  expect(offenders(listFiles('.', 'src'), /sidebar[-_]?material/i)).toEqual([])
  // The settings store's tests still feed the stored key in, to show it is dropped.
  expect(offenders(listFiles('.', 'src-tauri'), /sidebar[-_]material/i)).toEqual([])
})
