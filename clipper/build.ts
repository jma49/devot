import { build } from 'esbuild'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'

const manifest = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url), 'utf8'))
for (const browser of ['chrome', 'firefox']) {
  const outdir = new URL(`./dist/${browser}/`, import.meta.url)
  await mkdir(outdir, { recursive: true })
  await build({
    entryPoints: [
      'clipper/background.ts',
      'clipper/popup.ts',
      'clipper/options.ts',
      'clipper/content.ts',
    ],
    outdir: outdir.pathname,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome120', 'firefox121'],
  })
  for (const file of ['popup.html', 'options.html', 'style.css', '_locales'])
    await cp(new URL(`./${file}`, import.meta.url), new URL(file, outdir), { recursive: true })
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
