import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { tempDir } from '../support/temp-dirs'
import { clipper as en } from '../../src/renderer/src/i18n/en'
import { clipper as zhHans } from '../../src/renderer/src/i18n/zh-Hans'

it('builds both locales from the app catalogs and starts both backgrounds without a DOM', () => {
  const root = tempDir('devot-clipper-build-')
  execFileSync(process.execPath, ['clipper/build.ts'], {
    cwd: resolve(__dirname, '../..'),
    env: { ...process.env, DEVOT_CLIPPER_BUILD_ROOT: root },
  })
  for (const browser of ['chrome', 'firefox']) {
    for (const [locale, catalog] of [
      ['en', en.messages],
      ['zh_CN', zhHans.messages],
    ] as const) {
      const expected = Object.fromEntries(
        Object.entries(catalog)
          .filter(([key]) => key.startsWith('clipper.'))
          .map(([key, message]) => [key.slice('clipper.'.length), { message }]),
      )
      expect(Object.keys(expected).length).toBeGreaterThan(0)
      const generated = JSON.parse(
        readFileSync(join(root, browser, '_locales', locale, 'messages.json'), 'utf8'),
      )
      expect(generated).toEqual(expected)
      expect(Object.keys(generated).sort()).toEqual(
        Object.keys(en.messages)
          .filter((key) => key.startsWith('clipper.'))
          .map((key) => key.slice('clipper.'.length))
          .sort(),
      )
    }
    let listener: unknown
    runInNewContext(readFileSync(join(root, browser, 'background.js'), 'utf8'), {
      chrome: {
        runtime: {
          onMessage: {
            addListener: (value: unknown) => {
              listener = value
            },
          },
          onConnect: { addListener: () => {} },
          onInstalled: { addListener: () => {} },
        },
      },
    })
    expect(listener).toBeTypeOf('function')
  }
})
