import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { tempDir } from '../support/temp-dirs'

it('starts both bundled backgrounds without a document or window', () => {
  const root = tempDir('devot-clipper-build-')
  execFileSync(process.execPath, ['clipper/build.ts'], {
    cwd: resolve(__dirname, '../..'),
    env: { ...process.env, DEVOT_CLIPPER_BUILD_ROOT: root },
  })
  for (const browser of ['chrome', 'firefox']) {
    let listener: unknown
    runInNewContext(readFileSync(join(root, browser, 'background.js'), 'utf8'), {
      chrome: {
        runtime: {
          onMessage: {
            addListener: (value: unknown) => {
              listener = value
            },
          },
        },
      },
    })
    expect(listener).toBeTypeOf('function')
  }
})
