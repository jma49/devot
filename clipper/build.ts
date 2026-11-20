import { build } from 'esbuild'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { messages as en } from '../src/renderer/src/i18n/en/clipper.ts'
import { messages as zhHans } from '../src/renderer/src/i18n/zh-Hans/clipper.ts'

const manifest = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url), 'utf8'))
for (const browser of ['chrome', 'firefox']) {
  const root = process.env['DEVOT_CLIPPER_BUILD_ROOT']
  const outdir = new URL(
    `${browser}/`,
    root ? pathToFileURL(`${root}/`) : new URL('./dist/', import.meta.url),
  )
  await mkdir(outdir, { recursive: true })
  await build({
    entryPoints: [
      'clipper/background.ts',
      'clipper/popup.ts',
      'clipper/options.ts',
      'clipper/content.ts',
      'clipper/style.css',
    ],
    outdir: outdir.pathname,
    bundle: true,
    minify: true,
    format: 'iife',
    platform: 'browser',
    conditions: ['worker'],
    target: ['chrome120', 'firefox121'],
  })
  for (const file of ['popup.html', 'options.html', 'icons/'])
    await cp(new URL(`./${file}`, import.meta.url), new URL(file, outdir), {
      recursive: true,
    })
  await cp(
    new URL('../design/app-icon/dove.svg', import.meta.url),
    new URL('icons/dove.svg', outdir),
  )
  for (const [locale, catalog] of [
    ['en', en],
    ['zh_CN', zhHans],
  ] as const) {
    const directory = new URL(`_locales/${locale}/`, outdir)
    await mkdir(directory, { recursive: true })
    const messages = Object.fromEntries(
      Object.entries(catalog).map(([key, message]) => [key.slice('clipper.'.length), { message }]),
    )
    await writeFile(new URL('messages.json', directory), JSON.stringify(messages, null, 2) + '\n')
  }
  const output =
    browser === 'firefox'
      ? {
          ...manifest,
          background: { scripts: ['background.js'] },
          browser_specific_settings: {
            gecko: {
              id: 'clipper@devot.app',
              strict_min_version: '121.0',
              data_collection_permissions: { required: ['none'] },
            },
          },
        }
      : manifest
  await writeFile(new URL('manifest.json', outdir), JSON.stringify(output, null, 2) + '\n')
}
