import { readFileSync } from 'node:fs'
import { expect, openApp, test } from './fixtures'
import { pickPluginMenu, pluginFrame, servePlugins } from './plugins'

const manifest = JSON.parse(readFileSync('plugins/enex/devot-plugin.json', 'utf8'))
const main = readFileSync('plugins/enex/main.js', 'utf8')
const text = readFileSync('tests/fixtures/sample.enex', 'utf8')

test('imports .enex export files through the sandboxed plugin with metadata and an image', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await servePlugins(page, [{ manifest, main }])
  await page.addInitScript((source) => {
    // Emulate Tauri's attachment protocol with the bytes the real import stored in the harness.
    const attachmentSource = (url: string) => {
      const id = /^devot:\/\/file\/([^#]+)/.exec(url)?.[1]
      if (!id) return url
      const file = (
        JSON.parse(localStorage.getItem('devot.test.files') ?? '[]') as {
          id: string
          mime: string
          base64: string
        }[]
      ).find((stored) => stored.id === id)
      return file ? `data:${file.mime};base64,${file.base64}` : url
    }
    const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      ...src,
      set(value: string) {
        src.set!.call(this, attachmentSource(value))
      },
    })
    const setAttribute = HTMLImageElement.prototype.setAttribute
    HTMLImageElement.prototype.setAttribute = function (name, value) {
      setAttribute.call(this, name, name === 'src' ? attachmentSource(value) : value)
    }
    new MutationObserver(() => {
      for (const image of document.querySelectorAll<HTMLImageElement>(
        'img[src^="devot://file/"]',
      )) {
        const original = image.getAttribute('src')!
        const resolved = attachmentSource(original)
        if (resolved !== original) image.src = resolved
      }
    }).observe(document, { childList: true, subtree: true })
    window.devotIpcMocks = {
      ...window.devotIpcMocks,
      plugin_import_pick: () => [{ name: 'Archive.enex', text: source }],
    }
  }, text)
  await openApp(page)
  await pluginFrame(page, manifest.id)

  await page.keyboard.press('Meta+KeyK')
  const palette = page.getByRole('dialog', { name: 'Command Palette' })
  await palette.getByRole('combobox').fill('> Import Evernote Export Files')
  await expect(palette.getByRole('option', { name: /Import Evernote Export Files/ })).toBeVisible()
  if (process.env['DEVOT_ENEX_SCREENSHOTS'])
    await page.screenshot({ path: '/home/ubuntu/screens/enex-entry.png', animations: 'disabled' })
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(palette).toBeHidden()
  await pickPluginMenu(page, { kind: 'import', plugin: manifest.id, id: 'enex' })

  const tree = page.getByRole('tree', { name: 'Notebooks' })
  const archive = tree.getByRole('treeitem', { name: /^Archive\b/ })
  await expect(archive).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]').length),
    )
    .toBe(3)
  const notice = page.locator('[data-devot-plugin-notice]')
  await expect(notice.locator('.notice-text')).toHaveText('Imported 3 notes; 2 items skipped.')
  await expect(notice).not.toContainText('could not finish')
  if (process.env['DEVOT_ENEX_SCREENSHOTS'])
    await page.screenshot({ path: '/home/ubuntu/screens/enex-result.png', animations: 'disabled' })
  await archive.click()
  const rows = page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
  await expect(rows).toHaveCount(3)
  await expect(rows.filter({ hasText: 'Undated' })).toBeVisible()
  await expect(rows.filter({ hasText: 'Earlier update' })).toBeVisible()
  if (process.env['DEVOT_ENEX_SCREENSHOTS'])
    await page.screenshot({
      path: '/home/ubuntu/screens/enex-notebook.png',
      animations: 'disabled',
    })
  await rows.filter({ hasText: 'Research & plans' }).click()
  await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(
    'Research & plans',
  )
  const tags = page.getByRole('group', { name: 'Tags', exact: true })
  await expect(tags).toContainText('work')
  await expect(tags).toContainText('research & ideas')
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  const preview = page.getByRole('article', { name: 'Preview' })
  await expect(preview.locator('strong')).toHaveText('bold')
  await expect(preview.getByRole('link', { name: 'link', exact: true })).toHaveAttribute(
    'href',
    'https://example.com',
  )
  await expect(preview.getByRole('checkbox').nth(0)).toBeChecked()
  await expect(preview.getByRole('checkbox').nth(1)).not.toBeChecked()
  const image = preview.locator('img').first()
  await expect(preview.locator('img')).toHaveCount(1)
  await expect(image).toBeVisible()
  await expect
    .poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth))
    .toBe(320)
  await expect(image).not.toHaveClass(/image-missing/)
  await image.evaluate((el: HTMLImageElement) => el.decode())
  await expect(preview).not.toContainText('secret')
  if (process.env['DEVOT_ENEX_SCREENSHOTS'])
    await page.screenshot({ path: '/home/ubuntu/screens/enex-note.png', animations: 'disabled' })
  await page.getByRole('button', { name: /^Note info: / }).click()
  const info = page.getByRole('dialog', { name: 'Note info' })
  await expect(info.locator('time[data-info="created"]')).toHaveAttribute(
    'datetime',
    /2023-11-05T12:00:00/,
  )
  await expect(info.locator('time[data-info="updated"]')).toHaveAttribute(
    'datetime',
    /2023-11-06T13:00:00/,
  )
  if (process.env['DEVOT_ENEX_SCREENSHOTS'])
    await page.screenshot({ path: '/home/ubuntu/screens/enex-dates.png', animations: 'disabled' })
  await page.keyboard.press('Escape')
  await notice.getByRole('button', { name: 'Show Skipped' }).click()
  const skipped = page.getByRole('dialog', { name: 'Skipped import items' })
  await expect(skipped.getByRole('listitem')).toHaveCount(2)
  const pdf = skipped.getByRole('listitem').filter({ hasText: 'paper.pdf' })
  await expect(pdf).toContainText('Attachment type not supported')
  await expect(pdf.getByRole('button')).toHaveText('In note “Research & plans”')
  const encrypted = skipped.getByRole('listitem').filter({ hasText: 'Encrypted content' })
  await expect(encrypted).toContainText('Encrypted content cannot be imported')
  await expect(encrypted.getByRole('button')).toHaveText('In note “Research & plans”')
  if (process.env['DEVOT_ENEX_SCREENSHOTS'])
    await page.screenshot({ path: '/home/ubuntu/screens/enex-skipped.png', animations: 'disabled' })
  await page.keyboard.press('Escape')
  await expect(skipped).toBeHidden()
  await rows.filter({ hasText: 'Undated' }).click()
  await notice.getByRole('button', { name: 'Show Skipped' }).click()
  await skipped.getByRole('listitem').filter({ hasText: 'paper.pdf' }).getByRole('button').click()
  await expect(skipped).toBeHidden()
  await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(
    'Research & plans',
  )
  expect(
    await page.evaluate(() =>
      window.devotIpcCalls
        .filter((call) => call.cmd === 'plugin_import_pick')
        .map((call) => call.args),
    ),
  ).toEqual([{ plugin: manifest.id, format: 'enex' }])
})

test('an empty .enex export reports that nothing was imported', async ({ page }) => {
  await servePlugins(page, [{ manifest, main }])
  await page.addInitScript(() => {
    window.devotIpcMocks = {
      ...window.devotIpcMocks,
      plugin_import_pick: () => [{ name: 'Empty.enex', text: '<en-export/>' }],
    }
  })
  await openApp(page)
  await pluginFrame(page, manifest.id)
  await pickPluginMenu(page, { kind: 'import', plugin: manifest.id, id: 'enex' })
  await expect(page.locator('[data-devot-plugin-notice]')).toContainText('could not finish.')
  await expect(page.getByRole('listbox', { name: 'Notes' }).getByRole('option')).toHaveCount(0)
})
