import type { Page } from '@playwright/test'
import { expect, test, type TestWindow } from './fixtures'

const FILES: Record<string, string> = {
  'Inbox.md': '# Inbox\n\nSee [[Plan]] later.\n',
  'Projects/Plan.md': [
    '---',
    'title: Launch plan',
    'tags: [work, q4]',
    'status: active',
    '---',
    '# Heading',
    '',
    '![Board](img/board.png)',
    '',
  ].join('\n'),
  // Written on Windows: CRLF line endings.
  'Projects/Deep/Spec.md': 'No heading here.\r\n\r\n![Missing](missing.png)\r\n',
}

const SCAN = {
  id: 7,
  name: 'Vault',
  files: Object.keys(FILES).sort(),
  skipped: [{ path: 'Huge.md', code: 'E_IMPORT_FILE_TOO_LARGE' }],
}

const tree = (page: Page) => page.getByRole('tree', { name: 'Notebooks' })
const book = (page: Page, name: string) =>
  tree(page).getByRole('treeitem', { name: new RegExp(`^${name}\\b`) })
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const header = (page: Page) => page.getByRole('toolbar', { name: 'Toolbar' }).locator('.headline')
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Import Markdown Folder' })

/** Opens the app with the import commands answered from FILES. */
async function open(page: Page, options: { hold?: boolean } = {}) {
  await page.addInitScript(
    ({ files, hold }) => {
      const w = globalThis as unknown as TestWindow & { releaseImport?: () => void }
      let release = () => {}
      const held = hold ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve()
      w.releaseImport = () => release()
      w.devotIpcMocks = {
        import_read: async (args: { path: string }) => {
          await held
          const text = files[args.path]
          if (text === undefined) throw new Error('E_IMPORT_FILE_NOT_FOUND')
          return text
        },
        import_attach: (args: { path: string }) => {
          if (args.path !== 'Projects/img/board.png') throw new Error('E_IMPORT_FILE_NOT_FOUND')
          return null
        },
        import_finish: null,
        backups_list: { backups: [], lastError: null },
      }
    },
    { files: FILES, hold: options.hold ?? false },
  )
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'New Note', exact: true })).toBeEnabled()
}

/** What Rust sends when the user picked a folder (or the scan failed). */
const send = (page: Page, type: 'devot:import-ready' | 'devot:import-failed', detail: unknown) =>
  page.evaluate(
    ({ type: name, detail: payload }) => {
      const w = globalThis as unknown as {
        dispatchEvent(e: unknown): void
        CustomEvent: new (t: string, init: { detail: unknown }) => unknown
      }
      w.dispatchEvent(new w.CustomEvent(name, { detail: payload }))
    },
    { type, detail },
  )

const showBackups = (page: Page) =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      dispatchEvent(e: unknown): void
      CustomEvent: new (t: string) => unknown
    }
    w.dispatchEvent(new w.CustomEvent('devot:show-backups'))
  })
const backups = (page: Page) => page.getByRole('dialog', { name: 'Backups' })

const calls = (page: Page, cmd: string) =>
  page.evaluate(
    (c) => (globalThis as unknown as TestWindow).devotIpcCalls.filter((call) => call.cmd === c),
    cmd,
  )

test('imports a folder into nested notebooks with tags, status and images', async ({ page }) => {
  await open(page)
  await send(page, 'devot:import-ready', SCAN)

  await expect(dialog(page)).toContainText('Imported 3 notes into 3 notebooks.')
  await expect(dialog(page)).toContainText('1 image was added as an attachment.')
  const problems = dialog(page).getByRole('listitem')
  await expect(problems).toHaveCount(2)
  // A usage event with the counts only: no names or paths.
  await expect
    .poll(async () => (await calls(page, 'usage_record')).map((c) => c.args))
    .toContainEqual({
      name: 'import.finished',
      properties: {
        notes: 3,
        notebooks: 3,
        images: 1,
        problems: 2,
        durationMs: expect.any(Number),
      },
    })
  await expect(problems.nth(0)).toContainText('Huge.md')
  await expect(problems.nth(0)).toContainText('Larger than 10 MB')
  await expect(problems.nth(1)).toContainText('Projects/Deep/Spec.md')
  await expect(problems.nth(1)).toContainText('Projects/Deep/missing.png')
  await expect(problems.nth(1)).toContainText('File not found')
  await dialog(page).getByRole('button', { name: 'Done' }).click()
  await expect(dialog(page)).toBeHidden()

  // The folder is a notebook, its folders nested inside; it is shown.
  await expect(book(page, 'Vault')).toHaveAttribute('aria-selected', 'true')
  await expect(header(page)).toHaveText('Vault')
  await expect(book(page, 'Vault').getByRole('treeitem', { name: /^Projects\b/ })).toBeVisible()
  await expect(book(page, 'Projects').getByRole('treeitem', { name: /^Deep\b/ })).toBeVisible()
  await expect(noteRows(page)).toHaveCount(3)
  await expect(sidebar(page).getByRole('button', { name: /^work 1$/ })).toBeVisible()
  await expect(sidebar(page).getByRole('button', { name: /^q4 1$/ })).toBeVisible()
  await expect(sidebar(page).getByRole('button', { name: /^Active 1$/ })).toBeVisible()

  // Titles: front matter, first heading, file name.
  await expect(noteRows(page).filter({ hasText: 'Launch plan' })).toHaveCount(1)
  await expect(noteRows(page).filter({ hasText: 'Inbox' })).toHaveCount(1)
  await expect(noteRows(page).filter({ hasText: 'Spec' })).toHaveCount(1)

  // The image link points at the attachment; the rest of the text is kept.
  await noteRows(page).filter({ hasText: 'Launch plan' }).click()
  await expect(body(page)).toContainText('tags: [work, q4]')
  await expect(body(page)).toContainText('![Board](devot://file/')
  const attaches = await calls(page, 'import_attach')
  expect(attaches.map((c) => c.args['path']).sort()).toEqual([
    'Projects/Deep/missing.png',
    'Projects/img/board.png',
  ])
  const attach = attaches.find((c) => c.args['path'] === 'Projects/img/board.png')
  expect(attach?.args['id']).toBe(7)
  expect(String(attach?.args['fileId'])).toMatch(/^[0-9a-f-]{36}$/)
  await expect(body(page)).toContainText(`devot://file/${String(attach?.args['fileId'])}`)
  await noteRows(page).filter({ hasText: 'Inbox' }).click()
  await expect(body(page)).toContainText('See [[Plan]] later.')

  // Each listed file was read once, and the session was closed.
  expect((await calls(page, 'import_read')).map((c) => c.args['path'])).toEqual(SCAN.files)
  expect(await calls(page, 'import_finish')).toEqual([{ cmd: 'import_finish', args: { id: 7 } }])
})

test('a note written with CRLF line endings edits like any other', async ({ page }) => {
  await open(page)
  await send(page, 'devot:import-ready', SCAN)
  await dialog(page).getByRole('button', { name: 'Done' }).click()
  await noteRows(page).filter({ hasText: 'Spec' }).click()
  const lines = body(page).locator('.cm-line')
  await expect(lines).toHaveText(['No heading here.', '', '![Missing](missing.png)', ''])
  await lines.last().click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('X')
  await lines.nth(0).click()
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.type('Y')

  // Open another note and come back: the editor reloads the saved text.
  await noteRows(page).filter({ hasText: 'Inbox' }).click()
  await expect(body(page)).toContainText('See [[Plan]] later.')
  await noteRows(page).filter({ hasText: 'Spec' }).click()
  await expect(lines).toHaveText(['YNo heading here.', '', '![Missing](missing.png)', 'X'])
})

test('shows progress while importing and cannot be dismissed until done', async ({ page }) => {
  await open(page, { hold: true })
  await send(page, 'devot:import-ready', SCAN)
  await expect(dialog(page)).toContainText('Importing “Vault”…')
  await expect(dialog(page).getByRole('progressbar')).toBeVisible()
  await expect(dialog(page)).toContainText('0 of 3 files')
  await expect(dialog(page).getByRole('button', { name: 'Done' })).toHaveCount(0)
  // WebKit lets a page refuse Escape only a few times, then closes the
  // dialog anyway; the sheet must stay up all the same.
  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toBeVisible()
  }

  await page.evaluate(() => (globalThis as unknown as { releaseImport(): void }).releaseImport())
  await expect(dialog(page)).toContainText('Imported 3 notes into 3 notebooks.')
  await expect(dialog(page).getByRole('progressbar')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toBeHidden()

  // The next folder is imported as usual.
  await send(page, 'devot:import-ready', { ...SCAN, id: 9, name: 'Second', skipped: [] })
  await expect(dialog(page)).toContainText('Imported 3 notes into 3 notebooks.')
  await expect(header(page)).toHaveText('Second')
  await dialog(page).getByRole('button', { name: 'Done' }).click()
  await expect(dialog(page)).toBeHidden()
  expect((await calls(page, 'import_finish')).map((c) => c.args['id'])).toEqual([7, 9])
})

test('a folder that cannot be imported shows why', async ({ page }) => {
  await open(page)
  await send(page, 'devot:import-failed', 'E_IMPORT_TOO_MANY_FILES')
  await expect(dialog(page)).toContainText('The import failed (E_IMPORT_TOO_MANY_FILES).')
  await expect(dialog(page)).toContainText('more than 10,000 Markdown files')
  await dialog(page).getByRole('button', { name: 'Done' }).click()
  await expect(dialog(page)).toBeHidden()
  await expect(noteRows(page)).toHaveCount(0)
})

test('an empty folder says no Markdown files were found', async ({ page }) => {
  await open(page)
  await send(page, 'devot:import-ready', { id: 8, name: 'Photos', files: [], skipped: [] })
  await expect(dialog(page)).toContainText('No Markdown files were found in “Photos”.')
  await dialog(page).getByRole('button', { name: 'Done' }).click()
  await expect(book(page, 'Photos')).toHaveCount(0)
  expect(await calls(page, 'import_finish')).toEqual([{ cmd: 'import_finish', args: { id: 8 } }])
})

test('folders picked in a row wait until the previous result is closed', async ({ page }) => {
  await open(page, { hold: true })
  await send(page, 'devot:import-ready', SCAN)
  await send(page, 'devot:import-ready', { ...SCAN, id: 9, name: 'Second', skipped: [] })
  await send(page, 'devot:import-failed', 'E_IMPORT_FOLDER_TOO_LARGE')
  // The same scan sent twice is imported once.
  await send(page, 'devot:import-ready', SCAN)
  await expect(dialog(page)).toContainText('Importing \u201cVault\u201d\u2026')
  await page.evaluate(() => (globalThis as unknown as { releaseImport(): void }).releaseImport())

  await expect(dialog(page)).toContainText('Imported 3 notes into 3 notebooks.')
  await expect(dialog(page)).toContainText('Huge.md')
  await expect(header(page)).toHaveText('Vault')
  await dialog(page).getByRole('button', { name: 'Done' }).click()

  await expect(dialog(page)).toContainText('Imported 3 notes into 3 notebooks.')
  await expect(dialog(page)).not.toContainText('Huge.md')
  await expect(header(page)).toHaveText('Second')
  await dialog(page).getByRole('button', { name: 'Done' }).click()

  await expect(dialog(page)).toContainText('The import failed (E_IMPORT_FOLDER_TOO_LARGE).')
  await dialog(page).getByRole('button', { name: 'Done' }).click()
  await expect(dialog(page)).toBeHidden()
  expect((await calls(page, 'import_finish')).map((c) => c.args['id'])).toEqual([7, 9])
  await expect(tree(page).getByRole('treeitem', { name: /^Vault\b/ })).toHaveCount(1)
})

test('backups wait while an import runs, so a restore cannot mix with it', async ({ page }) => {
  await open(page, { hold: true })
  await send(page, 'devot:import-ready', SCAN)
  await expect(dialog(page)).toContainText('Importing \u201cVault\u201d\u2026')
  await showBackups(page)
  await expect(dialog(page)).toBeVisible()
  await expect(backups(page)).toHaveCount(0)

  await page.evaluate(() => (globalThis as unknown as { releaseImport(): void }).releaseImport())
  await expect(dialog(page)).toContainText('Imported 3 notes into 3 notebooks.')
  await expect(backups(page)).toHaveCount(0)
  await dialog(page).getByRole('button', { name: 'Done' }).click()
  await expect(backups(page)).toBeVisible()
  await expect(dialog(page)).toHaveCount(0)
})

test('a folder picked while Backups is open is imported once it closes', async ({ page }) => {
  await open(page)
  await showBackups(page)
  await expect(backups(page)).toBeVisible()
  await send(page, 'devot:import-ready', SCAN)
  await expect(dialog(page)).toHaveCount(0)
  expect(await calls(page, 'import_read')).toEqual([])

  await backups(page).getByRole('button', { name: 'Done' }).click()
  await expect(backups(page)).toBeHidden()
  await expect(dialog(page)).toContainText('Imported 3 notes into 3 notebooks.')
  await dialog(page).getByRole('button', { name: 'Done' }).click()
  await expect(dialog(page)).toBeHidden()
})

test('a finished import closes the trashed note that was open', async ({ page }) => {
  await open(page)
  const title = page.getByRole('textbox', { name: 'Title' })
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await title.fill('Doomed')
  await page.getByRole('button', { name: 'Move to Trash' }).click()
  await sidebar(page)
    .getByRole('button', { name: /^Trash \d+$/ })
    .click()
  await noteRows(page).filter({ hasText: 'Doomed' }).click()
  await expect(page.getByRole('status')).toContainText('This note is in the Trash.')

  await send(page, 'devot:import-ready', SCAN)
  await expect(dialog(page)).toContainText('Imported 3 notes into 3 notebooks.')
  await dialog(page).getByRole('button', { name: 'Done' }).click()
  await expect(header(page)).toHaveText('Vault')
  await expect(title).toHaveCount(0)
  await expect(body(page)).toHaveCount(0)
})
