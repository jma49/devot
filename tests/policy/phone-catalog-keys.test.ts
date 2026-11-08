import { existsSync, readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { messages } from '../../src/renderer/src/i18n/en/phone'
import { listFiles } from '../support/git-files'

const GENERATED = 'src-tauri/apple/DevotScreens/Sources/DevotScreens/Generated/Strings.swift'

const read = (paths: string[]) =>
  paths
    .filter((path) => path !== GENERATED && existsSync(path))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n')

/** Each key's Swift accessor, as `pnpm i18n:apple` names it. */
const accessors = new Map(
  [
    ...readFileSync(GENERATED, 'utf8').matchAll(
      /static func (\w+)\([^)]*\) -> String \{\s*(?:\w+\()?text\("([^"]+)"/g,
    ),
  ].map(([, name, key]) => [key!, name!]),
)

it('keeps no iPhone string that nothing shows', () => {
  const page = read(
    listFiles('.', 'src/renderer/src').filter(
      (path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) && !path.includes('/i18n/'),
    ),
  )
  const native = read(listFiles('.', 'src-tauri/apple').filter((path) => path.endsWith('.swift')))
  const unused = Object.keys(messages).filter((key) => {
    if (page.includes(`'${key}'`) || page.includes(`"${key}"`) || page.includes(`\`${key}`)) {
      return false
    }
    const accessor = accessors.get(key)
    return (
      !native.includes(`"${key}"`) && !(accessor && new RegExp(`\\b${accessor}\\(`).test(native))
    )
  })
  expect(unused).toStrictEqual([])
})
