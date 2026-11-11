import { globSync, readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

// docs/specs/stateful-code.md, One value, one owner: a ref that mirrors a render's value for what
// outlives the render (a listener, a timer, an answer) belongs to the render on screen. Set in a
// passive effect it holds the value before for as long as the paint takes, and an event in
// between acts on what is no longer shown (#893, #902).
it('mirrors no render value into a ref in a passive effect', () => {
  const mirror =
    /useEffect\(\(\) => \{\n\s*\w+\.current = (?!undefined\n|null\n|false\n|true\n)[^\n]+\n\s*\}(?:, \[[^\]]*\])?\)/
  const found = globSync('src/renderer/src/**/*.{ts,tsx}')
    .filter((file) => !/\.test\.tsx?$/.test(file))
    .filter((file) => mirror.test(readFileSync(file, 'utf8')))
  expect(found).toEqual([])
})
