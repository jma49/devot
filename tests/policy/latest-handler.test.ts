import { globSync, readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

// docs/specs/stateful-code.md, One value, one owner: a handler kept in a ref for a long-lived
// listener belongs to the render on screen. Set in a passive effect it is the one before for as
// long as the paint takes, and an event in between acts on what is no longer shown (#893).
it("sets no listener's latest handler in a passive effect", () => {
  const passive = /useEffect\(\(\) => \{\s*\n\s*latest\.current = /
  const found = globSync('src/renderer/src/**/*.{ts,tsx}')
    .filter((file) => !/\.test\.tsx?$/.test(file))
    .filter((file) => passive.test(readFileSync(file, 'utf8')))
  expect(found).toEqual([])
})
