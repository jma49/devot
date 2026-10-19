import type { Page } from '@playwright/test'
import { expect, pickMenuItem, test, type TestWindow, pickNoteMore } from './fixtures'

const FILES: Record<string, string> = {
  // Front matter of its own: kept in the note, nothing read from it.
  'Inbox.md': '---\nauthor: me\ntags: [ignored]\n---\n# Inbox\n\nSee [[Plan]] later.\n',
  // Exported by Devot: its own front matter gives the title, tags and status.
  'Projects/Plan.md': [
    '---',
    '# Devot metadata',
    "title: 'Launch plan'",
    "tags: ['work', 'q4']",
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
  kind: 'folder',
  files: Object.keys(FILES)
    .sort()
    .map((path) => ({ path, bytes: 2048 })),
  images: [{ path: 'Projects/img/board.png', bytes: 4096 }],
  skipped: [{ path: 'Huge.md', code: 'E_IMPORT_FILE_TOO_LARGE' }],
}
const PATHS = SCAN.files.map((f) => f.path)

const HTML_FILES: Record<string, string> = {
  'page.html':
    '<html><head><title>Saved page</title><script>alert(1)</script></head>' +
    '<body><h1>Saved</h1><p>Some <strong>bold</strong> text.</p></body></html>',
}

const tree = (page: Page) => page.getByRole('tree', { name: 'Notebooks' })
const book = (page: Page, name: string) =>
  tree(page).getByRole('treeitem', { name: new RegExp(`^${name}\\b`) })
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const header = (page: Page) => page.getByRole('toolbar', { name: 'Toolbar' }).locator('.headline')
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const dialog = (page: Page) => page.getByRole('dialog', { name: /^Import (Markdown|HTML)/ })
const button = (page: Page, name: string) => dialog(page).getByRole('button', { name, exact: true })
const destinations = (page: Page) => dialog(page).getByRole('listbox', { name: 'Import into' })

async function confirm(page: Page, into?: string) {
  if (await button(page, 'Continue').isVisible()) await button(page, 'Continue').click()
  if (into) await destinations(page).getByRole('option', { name: into }).click()
  await button(page, 'Import').click()
}

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
        import_pick: null,
        backups_list: { backups: [], lastError: null },
      }
    },
    { files: { ...FILES, ...HTML_FILES }, hold: options.hold ?? false },
  )
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'New Note', exact: true })).toBeEnabled()
}

const send = (
  page: Page,
  type:
    | 'devot:import-scanning'
    | 'devot:import-progress'
    | 'devot:import-ready'
    | 'devot:import-failed',
  detail: unknown,
) =>
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

const scanning = (page: Page, id = 7, name = 'Vault') =>
  send(page, 'devot:import-scanning', { id, name, kind: 'folder' })

test('scans, shows what it found and where it goes, and writes nothing before Import', async ({
  page,
}) => {
  await open(page)
  await scanning(page)
  await expect(dialog(page)).toHaveAccessibleName('Import Markdown Folder')
  await expect(dialog(page)).toContainText('Looking through \u201cVault\u201d\u2026')
  await expect(dialog(page).getByRole('progressbar', { name: 'Scan progress' })).toBeVisible()
  await send(page, 'devot:import-progress', { id: 7, files: 2, images: 1 })
  await expect(dialog(page)).toContainText('2 Markdown files and 1 image found so far')
  await expect(button(page, 'Cancel')).toBeVisible()

  await send(page, 'devot:import-ready', SCAN)
  await expect(dialog(page)).toContainText('Found 3 Markdown files and 1 image')
  const rows = dialog(page)
    .getByRole('list', { name: 'Folders found' })
    .locator('.import-folder-row')
  await expect(rows).toHaveCount(4)
  await expect(rows.nth(0)).toContainText('Vault')
  await expect(rows.nth(0)).not.toContainText('Notebook')
  await expect(rows.nth(1)).toContainText('Projects')
  await expect(rows.nth(1)).toContainText('Notebook')
  await expect(rows.nth(1)).toContainText('2 Markdown files \u00b7 1 image')
  await expect(rows.nth(2)).toContainText('Deep')
  await expect(rows.nth(2)).toContainText('Notebook')
  await expect(rows.nth(3)).toContainText('img')
  await expect(rows.nth(3)).not.toContainText('Notebook')
  await expect(dialog(page)).toContainText('Will be skipped')
  await expect(dialog(page).getByRole('listitem').filter({ hasText: 'Huge.md' })).toContainText(
    'Larger than 10 MB (E_IMPORT_FILE_TOO_LARGE)',
  )

  await button(page, 'Continue').click()
  await expect(destinations(page).getByRole('option', { name: 'No Notebook' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await button(page, 'Back').click()
  await expect(rows).toHaveCount(4)
  await button(page, 'Continue').click()

  expect(await calls(page, 'import_read')).toEqual([])
  expect(await calls(page, 'import_finish')).toEqual([])
  await expect(tree(page).getByRole('treeitem')).toHaveCount(0)
  await expect(noteRows(page)).toHaveCount(0)

  await button(page, 'Import').click()
  await expect(dialog(page)).toContainText('Imported 3 notes into 2 notebooks.')
  await expect(dialog(page)).toContainText('1 image was added as an attachment.')
  await expect(dialog(page)).toContainText('3 imported \u00b7 1 skipped \u00b7 0 failed')
  const problems = dialog(page).getByRole('listitem')
  await expect(problems).toHaveCount(2)
  await expect(problems.nth(0)).toContainText('Huge.md')
  await expect(problems.nth(1)).toContainText('Projects/Deep/Spec.md')
  await expect(problems.nth(1)).toContainText('Projects/Deep/missing.png')
  await expect(problems.nth(1)).toContainText('File not found (E_IMPORT_FILE_NOT_FOUND)')
  // A usage event with the counts only: no names or paths.
  await expect
    .poll(async () => (await calls(page, 'usage_record')).map((c) => c.args))
    .toContainEqual({
      name: 'import.finished',
      properties: {
        notes: 3,
        notebooks: 2,
        images: 1,
        problems: 2,
        durationMs: expect.any(Number),
      },
    })
  await button(page, 'Done').click()
  await expect(dialog(page)).toBeHidden()

  await expect(book(page, 'Vault')).toHaveCount(0)
  await expect(book(page, 'Projects')).toHaveAttribute('aria-selected', 'true')
  await expect(header(page)).toHaveText('Projects')
  await expect(book(page, 'Deep')).toBeVisible()
  await expect(noteRows(page)).toHaveCount(2)
  await expect(sidebar(page).getByRole('button', { name: /^work 1$/ })).toBeVisible()
  await expect(sidebar(page).getByRole('button', { name: /^q4 1$/ })).toBeVisible()
  await expect(sidebar(page).getByRole('button', { name: /^Active 1$/ })).toBeVisible()
  await expect(sidebar(page).getByRole('button', { name: /^ignored\b/ })).toHaveCount(0)

  await noteRows(page).filter({ hasText: 'Launch plan' }).click()
  await expect(body(page)).not.toContainText('Devot metadata')
  await expect(body(page)).toContainText('![Board](devot://file/')
  const attach = (await calls(page, 'import_attach')).find(
    (c) => c.args['path'] === 'Projects/img/board.png',
  )
  expect(attach?.args['id']).toBe(7)
  expect(String(attach?.args['fileId'])).toMatch(/^[0-9a-f-]{36}$/)
  await expect(body(page)).toContainText(`devot://file/${String(attach?.args['fileId'])}`)

  await sidebar(page)
    .getByRole('button', { name: /^All Notes/ })
    .click()
  await noteRows(page).filter({ hasText: 'Inbox' }).click()
  await expect(body(page)).toContainText('tags: [ignored]')
  await expect(body(page)).toContainText('See [[Plan]] later.')

  expect((await calls(page, 'import_read')).map((c) => c.args['path'])).toEqual(PATHS)
  expect(await calls(page, 'import_finish')).toEqual([{ cmd: 'import_finish', args: { id: 7 } }])
})

test('imports into the notebook chosen, the open one to begin with', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: 'New Notebook' }).click()
  const field = page.getByRole('textbox', { name: 'Notebook name' })
  await field.fill('Archive')
  await field.press('Enter')
  await expect(book(page, 'Archive')).toBeVisible()
  await book(page, 'Archive').locator('> .book-row').click()

  await send(page, 'devot:import-ready', SCAN)
  await button(page, 'Continue').click()
  await expect(destinations(page).getByRole('option', { name: 'Archive' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await dialog(page).getByRole('combobox', { name: 'Filter notebooks' }).fill('no note')
  await expect(destinations(page).getByRole('option')).toHaveText(['No Notebook'])
  await expect(destinations(page).getByRole('option')).toHaveAttribute('aria-selected', 'true')
  const filter = dialog(page).getByRole('combobox', { name: 'Filter notebooks' })
  await filter.fill('zzz')
  await expect(destinations(page).getByRole('option')).toHaveCount(0)
  await expect(button(page, 'Import')).toBeDisabled()
  await filter.press('Enter')
  await expect(button(page, 'Import')).toBeVisible()
  expect(await calls(page, 'import_read')).toEqual([])
  await filter.fill('')
  await expect(button(page, 'Import')).toBeEnabled()
  await confirm(page, 'Archive')
  await expect(dialog(page)).toContainText('Imported 3 notes into 2 notebooks.')
  await button(page, 'Done').click()
  await expect(header(page)).toHaveText('Archive')
  await expect(noteRows(page)).toHaveCount(3)
})

test('shows a sub-notebook indented under its parent in the destination list', async ({ page }) => {
  await open(page)
  for (const name of ['Work', 'Notes']) {
    await page.getByRole('button', { name: 'New Notebook' }).click()
    const field = page.getByRole('textbox', { name: 'Notebook name' })
    await field.fill(name)
    await field.press('Enter')
    await expect(book(page, name)).toBeVisible()
  }
  await book(page, 'Notes').locator('> .book-row').dragTo(book(page, 'Work').locator('> .book-row'))

  await send(page, 'devot:import-ready', SCAN)
  await button(page, 'Continue').click()
  const indent = (name: string) =>
    destinations(page)
      .getByRole('option', { name })
      .evaluate((el) => parseFloat(getComputedStyle(el).paddingInlineStart))
  const work = await indent('Work')
  expect(await indent('Notes')).toBeGreaterThan(work)
  await dialog(page).getByRole('combobox', { name: 'Filter notebooks' }).fill('notes')
  await expect(destinations(page).getByRole('option')).toHaveText(['Work', 'Notes'])
})

test('can be cancelled at every step before Import, which ends the session', async ({ page }) => {
  await open(page)
  await scanning(page, 7)
  await button(page, 'Cancel').click()
  await expect(dialog(page)).toBeHidden()
  // What a cancelled scan sends later is ignored.
  await send(page, 'devot:import-progress', { id: 7, files: 1, images: 0 })
  await send(page, 'devot:import-ready', SCAN)
  await expect(dialog(page)).toHaveCount(0)

  await send(page, 'devot:import-ready', { ...SCAN, id: 8 })
  await button(page, 'Cancel').click()
  await expect(dialog(page)).toBeHidden()
  await send(page, 'devot:import-ready', { ...SCAN, id: 9 })
  await button(page, 'Continue').click()
  await button(page, 'Cancel').click()
  await expect(dialog(page)).toBeHidden()
  await send(page, 'devot:import-ready', { ...SCAN, id: 10 })
  await expect(button(page, 'Continue')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toBeHidden()

  expect((await calls(page, 'import_finish')).map((c) => c.args['id'])).toEqual([7, 8, 9, 10])
  expect(await calls(page, 'import_read')).toEqual([])
  await expect(tree(page).getByRole('treeitem')).toHaveCount(0)
  await expect(noteRows(page)).toHaveCount(0)
})

test('picked Markdown files go straight to the destination, then show the same result', async ({
  page,
}) => {
  await open(page)
  await send(page, 'devot:import-ready', {
    id: 11,
    name: 'Inbox.md',
    kind: 'files',
    files: [{ path: 'Inbox.md', bytes: 64 }],
    images: [],
    skipped: [{ path: 'notes.txt', code: 'E_IMPORT_FILE_TYPE' }],
  })
  await expect(dialog(page)).toHaveAccessibleName('Import Markdown Files')
  await expect(button(page, 'Continue')).toHaveCount(0)
  await expect(button(page, 'Back')).toHaveCount(0)
  await expect(destinations(page)).toBeVisible()
  await expect(dialog(page)).toContainText('notes.txt')
  await button(page, 'Import').click()
  await expect(dialog(page)).toContainText('Imported 1 note.')
  await expect(dialog(page)).toContainText('1 imported \u00b7 1 skipped \u00b7 0 failed')
  await button(page, 'Done').click()
  await expect(noteRows(page).filter({ hasText: 'Inbox' })).toHaveCount(1)
})

test("a notebook's Import menu imports into that notebook without asking where", async ({
  page,
}) => {
  await open(page)
  for (const name of ['Work', 'Home']) {
    await page.getByRole('button', { name: 'New Notebook' }).click()
    const field = page.getByRole('textbox', { name: 'Notebook name' })
    await field.fill(name)
    await field.press('Enter')
    await expect(book(page, name)).toBeVisible()
  }
  const menus = () => calls(page, 'plugin:menu|popup').then((c) => c.length)
  const before = await menus()
  await book(page, 'Work').locator('> .book-row').click({ button: 'right' })
  await expect.poll(menus).toBe(before + 1)
  await pickMenuItem(page, 'Markdown Files…', 'Import')
  await expect.poll(async () => (await calls(page, 'import_pick')).length).toBe(1)
  const args = (await calls(page, 'import_pick'))[0]!.args as { kind: string; bookId: string }
  expect(args.kind).toBe('markdownFiles')

  // Rust answers with the session, its destination set: picked files import at once.
  await send(page, 'devot:import-ready', {
    id: 21,
    name: 'Inbox.md',
    kind: 'files',
    files: [{ path: 'Inbox.md', bytes: 64 }],
    images: [],
    skipped: [],
    destination: args.bookId,
  })
  await expect(dialog(page)).toContainText('Imported 1 note.')
  await expect(destinations(page)).toHaveCount(0)
  await button(page, 'Done').click()
  await book(page, 'Work').locator('> .book-row').click()
  await expect(noteRows(page).filter({ hasText: 'Inbox' })).toHaveCount(1)

  await send(page, 'devot:import-ready', { ...SCAN, id: 22, destination: args.bookId })
  await expect(button(page, 'Continue')).toHaveCount(0)
  await button(page, 'Import into “Work”').click()
  await expect(dialog(page)).toContainText('Imported 3 notes into 2 notebooks.')
  await button(page, 'Done').click()
  await expect(header(page)).toHaveText('Work')
})

test('picked HTML files become Markdown notes, with no script left', async ({ page }) => {
  await open(page)
  await send(page, 'devot:import-ready', {
    id: 12,
    name: 'page.html',
    kind: 'files',
    files: [{ path: 'page.html', bytes: 200 }],
    images: [],
    skipped: [],
  })
  await expect(dialog(page)).toHaveAccessibleName('Import HTML Files')
  await button(page, 'Import').click()
  await expect(dialog(page)).toContainText('Imported 1 note.')
  await button(page, 'Done').click()
  await noteRows(page).filter({ hasText: 'Saved page' }).click()
  await expect(body(page)).toContainText('# Saved')
  await expect(body(page)).toContainText('Some **bold** text.')
  await expect(body(page)).not.toContainText('alert')
})

test('a note written with CRLF line endings edits like any other', async ({ page }) => {
  await open(page)
  await send(page, 'devot:import-ready', SCAN)
  await confirm(page)
  await button(page, 'Done').click()
  await noteRows(page).filter({ hasText: 'Spec' }).click()
  const lines = body(page).locator('.cm-line')
  await expect(lines).toHaveText(['No heading here.', '', '![Missing](missing.png)', ''])
  await lines.last().click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('X')
  await lines.nth(0).click()
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.type('Y')

  await noteRows(page).filter({ hasText: 'Launch plan' }).click()
  await expect(body(page)).toContainText('# Heading')
  await noteRows(page).filter({ hasText: 'Spec' }).click()
  await expect(lines).toHaveText(['YNo heading here.', '', '![Missing](missing.png)', 'X'])
})

test('shows progress while importing and cannot be dismissed until done', async ({ page }) => {
  await open(page, { hold: true })
  await send(page, 'devot:import-ready', SCAN)
  await confirm(page)
  await expect(dialog(page)).toContainText('Importing \u201cVault\u201d\u2026')
  await expect(dialog(page).getByRole('progressbar')).toBeVisible()
  await expect(dialog(page)).toContainText('0 of 3 files')
  await expect(button(page, 'Done')).toHaveCount(0)
  await expect(button(page, 'Cancel')).toHaveCount(0)
  // WebKit lets a page refuse Escape only a few times, then closes the
  // dialog anyway; the sheet must stay up all the same.
  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toBeVisible()
  }

  await page.evaluate(() => (globalThis as unknown as { releaseImport(): void }).releaseImport())
  await expect(dialog(page)).toContainText('Imported 3 notes into 2 notebooks.')
  await expect(dialog(page).getByRole('progressbar')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toBeHidden()

  await send(page, 'devot:import-ready', { ...SCAN, id: 9, name: 'Second', skipped: [] })
  await confirm(page)
  await expect(dialog(page)).toContainText('Imported 3 notes into 2 notebooks.')
  await button(page, 'Done').click()
  await expect(dialog(page)).toBeHidden()
  expect((await calls(page, 'import_finish')).map((c) => c.args['id'])).toEqual([7, 9])
})

test('a scan that fails shows why, in the sheet it started', async ({ page }) => {
  await open(page)
  await send(page, 'devot:import-failed', { id: null, code: 'E_IMPORT_TOO_MANY_FILES' })
  await expect(dialog(page)).toContainText('The import failed (E_IMPORT_TOO_MANY_FILES).')
  await expect(dialog(page)).toContainText('more than 10,000 Markdown files')
  await button(page, 'Done').click()
  await expect(dialog(page)).toBeHidden()

  await scanning(page, 13)
  await expect(dialog(page)).toContainText('Looking through')
  await send(page, 'devot:import-failed', { id: 13, code: 'E_IMPORT_FOLDER_TOO_LARGE' })
  await expect(dialog(page)).toContainText('The import failed (E_IMPORT_FOLDER_TOO_LARGE).')
  await button(page, 'Done').click()
  await expect(dialog(page)).toBeHidden()
  await expect(noteRows(page)).toHaveCount(0)
})

test('an empty folder says no Markdown files were found', async ({ page }) => {
  await open(page)
  await send(page, 'devot:import-ready', {
    id: 8,
    name: 'Photos',
    kind: 'folder',
    files: [],
    images: [{ path: 'cat.png', bytes: 10 }],
    skipped: [],
  })
  await expect(dialog(page)).toContainText('No Markdown files were found in \u201cPhotos\u201d.')
  await expect(button(page, 'Continue')).toHaveCount(0)
  await button(page, 'Done').click()
  await expect(tree(page).getByRole('treeitem')).toHaveCount(0)
  expect(await calls(page, 'import_finish')).toEqual([{ cmd: 'import_finish', args: { id: 8 } }])
})

test('imports picked in a row wait until the previous one is closed', async ({ page }) => {
  await open(page, { hold: true })
  await send(page, 'devot:import-ready', SCAN)
  await scanning(page, 9, 'Second')
  await send(page, 'devot:import-failed', { id: null, code: 'E_IMPORT_ROOT_INVALID' })
  await send(page, 'devot:import-ready', SCAN)
  await send(page, 'devot:import-ready', { ...SCAN, id: 9, name: 'Second', skipped: [] })
  await confirm(page)
  await expect(dialog(page)).toContainText('Importing \u201cVault\u201d\u2026')
  await page.evaluate(() => (globalThis as unknown as { releaseImport(): void }).releaseImport())
  await expect(dialog(page)).toContainText('Imported 3 notes into 2 notebooks.')
  await expect(dialog(page)).toContainText('Huge.md')
  await button(page, 'Done').click()

  await expect(dialog(page)).toContainText('Found 3 Markdown files')
  await expect(dialog(page)).not.toContainText('Huge.md')
  await confirm(page)
  await expect(dialog(page)).toContainText('Imported 3 notes into 2 notebooks.')
  await button(page, 'Done').click()

  await expect(dialog(page)).toContainText('The import failed (E_IMPORT_ROOT_INVALID).')
  await button(page, 'Done').click()
  await expect(dialog(page)).toBeHidden()
  expect((await calls(page, 'import_finish')).map((c) => c.args['id'])).toEqual([7, 9])
  expect(await calls(page, 'import_read')).toHaveLength(6)
})

test('backups wait while an import runs, so a restore cannot mix with it', async ({ page }) => {
  await open(page, { hold: true })
  await send(page, 'devot:import-ready', SCAN)
  await confirm(page)
  await expect(dialog(page)).toContainText('Importing \u201cVault\u201d\u2026')
  await showBackups(page)
  await expect(dialog(page)).toBeVisible()
  await expect(backups(page)).toHaveCount(0)

  await page.evaluate(() => (globalThis as unknown as { releaseImport(): void }).releaseImport())
  await expect(dialog(page)).toContainText('Imported 3 notes into 2 notebooks.')
  await expect(backups(page)).toHaveCount(0)
  await button(page, 'Done').click()
  await expect(backups(page)).toBeVisible()
  await expect(dialog(page)).toHaveCount(0)
})

test('a folder picked while Backups is open is shown once it closes', async ({ page }) => {
  await open(page)
  await showBackups(page)
  await expect(backups(page)).toBeVisible()
  await send(page, 'devot:import-ready', SCAN)
  await expect(dialog(page)).toHaveCount(0)

  await backups(page).getByRole('button', { name: 'Done' }).click()
  await expect(backups(page)).toBeHidden()
  await confirm(page)
  await expect(dialog(page)).toContainText('Imported 3 notes into 2 notebooks.')
  await button(page, 'Done').click()
  await expect(dialog(page)).toBeHidden()
})

test('a finished import closes the trashed note that was open', async ({ page }) => {
  await open(page)
  const title = page.getByRole('textbox', { name: 'Title' })
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await title.fill('Doomed')
  await pickNoteMore(page, 'Move to Trash')
  await sidebar(page)
    .getByRole('button', { name: /^Trash \d+$/ })
    .click()
  await noteRows(page).filter({ hasText: 'Doomed' }).click()
  await expect(
    page.getByRole('status').filter({ hasText: 'This note is in the Trash.' }),
  ).toContainText('This note is in the Trash.')

  await send(page, 'devot:import-ready', SCAN)
  await confirm(page)
  await expect(dialog(page)).toContainText('Imported 3 notes into 2 notebooks.')
  await button(page, 'Done').click()
  await expect(header(page)).toHaveText('Projects')
  await expect(title).toHaveCount(0)
  await expect(body(page)).toHaveCount(0)
})
