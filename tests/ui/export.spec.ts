import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Page } from '@playwright/test'
import {
  clipboardWrites,
  expect,
  pickMenuItem,
  shownMenu,
  test,
  type IpcCall,
  type TestWindow,
} from './fixtures'

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const noteRow = (page: Page, title: string) => noteRows(page).filter({ hasText: title })
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const tree = (page: Page) => page.getByRole('tree', { name: 'Notebooks' })
const bookRow = (page: Page, name: string) =>
  tree(page)
    .getByRole('treeitem', { name: new RegExp(`^${name}\\b`) })
    .locator('> .book-row')

const FILE = '0192a6f0-0000-7000-8000-00000000f001'
const BODY = `# Plan\n\n![Board](devot://file/${FILE})\n\n> [!NOTE]\n> Check.\n`
const DIAGRAM = '```mermaid\ngraph TD\n  Start --> Finish\n```\n'
const SIZED = `![Half](devot://file/${FILE}#half)\n`

async function createNote(page: Page, title: string, text: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(titleField(page)).toHaveValue('')
  await titleField(page).fill(title)
  await body(page).click()
  await page.keyboard.insertText(text)
  await expect(noteRow(page, title)).toHaveCount(1)
}

async function mockExport(page: Page, mocks: Record<string, unknown> = {}) {
  await page.evaluate((more) => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = {
      export_begin: { id: 7, fileName: 'Plan.md' },
      export_attach: 'attachments/board.png',
      export_write: null,
      export_finish: null,
      clipboard_write_html: null,
      note_print: true,
      export_pdf: true,
      ...more,
    }
  }, mocks)
}

const calls = (page: Page, cmd: string) =>
  page.evaluate(
    (name) =>
      (globalThis as unknown as TestWindow).devotIpcCalls.filter((c: IpcCall) => c.cmd === name),
    cmd,
  )

const popups = (page: Page) => calls(page, 'plugin:menu|popup').then((c) => c.length)

async function pickFromNoteMenu(page: Page, title: string, item: string) {
  const before = await popups(page)
  await noteRow(page, title).click({ button: 'right' })
  await expect.poll(() => popups(page)).toBe(before + 1)
  await pickMenuItem(page, item)
}

const pageSetup = (page: Page) => page.getByRole('dialog', { name: 'Page Setup' })

/** Print or Export as PDF goes on from Page Setup, as it is. */
async function confirmPageSetup(page: Page, button: 'Print…' | 'Export…') {
  await pageSetup(page).getByRole('button', { name: button }).click()
  await expect(pageSetup(page)).toHaveCount(0)
}

async function noteId(page: Page, title: string): Promise<string> {
  const before = (await clipboardWrites(page)).length
  await pickFromNoteMenu(page, title, 'Copy Note ID')
  await expect.poll(async () => (await clipboardWrites(page)).length).toBe(before + 1)
  return (await clipboardWrites(page))[before]!
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('Export as Markdown… writes the note with its attachments linked relatively', async ({
  page,
}) => {
  await createNote(page, 'Plan', `${BODY}\n${SIZED}`)
  await mockExport(page)
  await pickFromNoteMenu(page, 'Plan', 'Export as Markdown…')
  await expect.poll(async () => (await calls(page, 'export_finish')).length).toBe(1)
  expect((await calls(page, 'export_begin')).map((c) => c.args)).toEqual([
    { kind: 'note', format: 'markdown', name: 'Plan' },
  ])
  // Copied once; the sized link keeps its size as the path's fragment.
  expect((await calls(page, 'export_attach')).map((c) => c.args)).toEqual([{ id: 7, fileId: FILE }])
  const [write] = await calls(page, 'export_write')
  expect(write?.args).toEqual({
    id: 7,
    path: 'Plan.md',
    text: `${BODY}\n${SIZED}`.replaceAll(`devot://file/${FILE}`, 'attachments/board.png'),
    images: [],
  })
  expect((await calls(page, 'export_finish')).map((c) => c.args)).toEqual([{ id: 7 }])
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('Export as HTML… writes a page of its own: the preview, styled, images and diagram in it', async ({
  page,
}) => {
  await createNote(page, 'Plan', `${BODY}\n${SIZED}\n${DIAGRAM}`)
  await mockExport(page, { export_begin: { id: 3, fileName: 'Plan.html' } })
  await pickFromNoteMenu(page, 'Plan', 'Export as HTML…')
  // Draw the diagram first: Mermaid loads on first use.
  await expect
    .poll(async () => (await calls(page, 'export_finish')).length, { timeout: 20_000 })
    .toBe(1)
  expect((await calls(page, 'export_begin'))[0]?.args).toEqual({
    kind: 'note',
    format: 'html',
    name: 'Plan',
  })
  const [write] = await calls(page, 'export_write')
  const args = write!.args as { path: string; text: string; images: unknown[] }
  expect(args.path).toBe('Plan.html')
  const html = args.text
  expect(html.startsWith('<!doctype html>')).toBe(true)
  expect(html).toContain('<title>Plan</title>')
  expect(html).toContain("default-src 'none'")
  expect(html).toMatch(/--color-text-primary: [^;]+;/)
  expect(html).toContain('.alert .alert-title')
  expect(html).toContain('<article class="preview"><h1 id="user-content-plan">Plan</h1>')
  expect(html).toMatch(
    /<div class="alert alert-note"><p class="alert-title">(<svg[^>]*>.*?<\/svg>)?Note<\/p>/,
  )
  expect(html).toMatch(/<div class="island island-mermaid"><svg[^>]*>/)
  expect(html).not.toMatch(/<script|data-source-line|data-devot-island/)
  expect(args.images).toHaveLength(1)
  const [image] = args.images as { placeholder: string; fileId: string }[]
  expect(image?.fileId).toBe(FILE)
  expect(html).toContain(`<img src="${image!.placeholder}" alt="Board" class="image-block">`)
  expect(html).toContain(
    `<img src="${image!.placeholder}" alt="Half" class="image-size-half image-block">`,
  )
  expect(html).toContain('.preview img.image-size-half')
  expect(html).toMatch(/--size-image-small: [^;]+;/)
})

test('Copy as HTML copies the page; Copy as Simple HTML only plain markup', async ({ page }) => {
  await createNote(page, 'Plan', BODY)
  await mockExport(page)
  await pickFromNoteMenu(page, 'Plan', 'Copy as HTML')
  await expect.poll(async () => (await calls(page, 'clipboard_write_html')).length).toBe(1)
  await pickFromNoteMenu(page, 'Plan', 'Copy as Simple HTML')
  await expect.poll(async () => (await calls(page, 'clipboard_write_html')).length).toBe(2)
  const [full, simple] = (await calls(page, 'clipboard_write_html')).map(
    (c) => c.args as { html: string; images: { fileId: string }[] },
  )
  expect(full!.html).toContain('<article class="preview">')
  expect(full!.images.map((i) => i.fileId)).toEqual([FILE])
  expect(simple!.html.startsWith('<h1>Plan</h1>')).toBe(true)
  expect(simple!.html).toContain('<blockquote><p><strong>Note</strong></p>')
  expect(simple!.html).not.toMatch(/\s(?:class|style|id|data-[a-z-]+)=|<style|<!doctype/)
  expect(simple!.images.map((i) => i.fileId)).toEqual([FILE])
})

test('Print… and Shift+Cmd+P print the preview; Export as PDF… saves it', async ({ page }) => {
  await createNote(page, 'Plan', BODY)
  await mockExport(page)
  await pickFromNoteMenu(page, 'Plan', 'Print…')
  await confirmPageSetup(page, 'Print…')
  await expect.poll(async () => (await calls(page, 'note_print')).length).toBe(1)
  // From the editor too (Cmd+P is Split view); Return prints.
  await body(page).click()
  await page.keyboard.press('Meta+Shift+P')
  await expect(pageSetup(page)).toBeVisible()
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await calls(page, 'note_print')).length).toBe(2)
  await expect(page.getByRole('dialog', { name: 'Command Palette' })).toHaveCount(0)
  const printed = (await calls(page, 'note_print'))[0]!.args as { title: string; html: string }
  expect(printed.title).toBe('Plan')
  expect(printed.html).toContain('<article class="preview"><h1 id="user-content-plan">Plan</h1>')

  await pickFromNoteMenu(page, 'Plan', 'Export as PDF…')
  await confirmPageSetup(page, 'Export…')
  await expect.poll(async () => (await calls(page, 'export_pdf')).length).toBe(1)
  const pdf = (await calls(page, 'export_pdf'))[0]!.args as Record<string, unknown>
  expect(pdf['name']).toBe('Plan')
  expect(pdf['title']).toBe('Plan')
  expect(String(pdf['html'])).toContain('<article class="preview">')
})

test('Page Setup comes first: it remembers the paper, margins, header and footer', async ({
  page,
}) => {
  await createNote(page, 'Plan', BODY)
  await mockExport(page)
  await pickFromNoteMenu(page, 'Plan', 'Print…')
  const dialog = pageSetup(page)
  await expect(dialog).toBeVisible()
  // The defaults: A4, normal margins, page numbers in the footer's centre.
  await expect(dialog.getByRole('combobox', { name: 'Paper' })).toHaveValue('a4')
  await expect(dialog.getByRole('combobox', { name: 'Margins' })).toHaveValue('normal')
  await expect(dialog.getByRole('textbox', { name: 'Footer Centre' })).toHaveValue(
    '{page} / {total}',
  )
  await expect(dialog.getByRole('button', { name: 'Print…' })).toBeFocused()

  // Cancel prints nothing and keeps the settings.
  await dialog.getByRole('textbox', { name: 'Header Left' }).fill('Draft')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  await pickFromNoteMenu(page, 'Plan', 'Print…')
  await expect(dialog.getByRole('textbox', { name: 'Header Left' })).toHaveValue('')
  // So does Escape.
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(await calls(page, 'note_print')).toHaveLength(0)

  await pickFromNoteMenu(page, 'Plan', 'Export as PDF…')
  await dialog.getByRole('combobox', { name: 'Paper' }).selectOption('slide')
  await dialog.getByRole('combobox', { name: 'Margins' }).selectOption('narrow')
  await dialog.getByRole('textbox', { name: 'Header Left' }).fill('{title}')
  await dialog.getByRole('textbox', { name: 'Footer Right' }).fill('{date}')
  await dialog.getByRole('checkbox', { name: 'Leave them off the first page' }).check()
  await dialog
    .getByRole('checkbox', { name: 'Thin rules under the header and above the footer' })
    .check()
  // Return in a slot goes on, like the button.
  await dialog.getByRole('textbox', { name: 'Footer Right' }).press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect.poll(async () => (await calls(page, 'export_pdf')).length).toBe(1)
  // Stored before the PDF is made: Rust lays the page out by the settings.
  const sets = await calls(page, 'editor_settings_set')
  expect(sets.at(-1)!.args['patch']).toEqual({
    pagePaper: 'slide',
    pageMargins: 'narrow',
    pageHeaderLeft: '{title}',
    pageHeaderCenter: '',
    pageHeaderRight: '',
    pageFooterLeft: '',
    pageFooterCenter: '{page} / {total}',
    pageFooterRight: '{date}',
    pageSkipFirst: true,
    pageRules: true,
  })
  const ipc = await page.evaluate(() => (globalThis as unknown as TestWindow).devotIpcCalls)
  const order = ipc.map((c: IpcCall) => c.cmd)
  expect(order.lastIndexOf('editor_settings_set')).toBeLessThan(order.indexOf('export_pdf'))
  // How the header and footer look comes from the design tokens.
  const look = (await calls(page, 'export_pdf'))[0]!.args['look'] as {
    text: Record<string, number>
    rule: Record<string, number>
    fontSize: number
  }
  expect(look.fontSize).toBe(10)
  for (const c of [look.text, look.rule])
    for (const v of Object.values(c)) expect(v >= 0 && v <= 1).toBe(true)

  // The next time it starts from what was used.
  await pickFromNoteMenu(page, 'Plan', 'Print…')
  await expect(dialog.getByRole('combobox', { name: 'Paper' })).toHaveValue('slide')
  await expect(dialog.getByRole('textbox', { name: 'Header Left' })).toHaveValue('{title}')
  await expect(
    dialog.getByRole('checkbox', { name: 'Leave them off the first page' }),
  ).toBeChecked()
  await confirmPageSetup(page, 'Print…')
  await expect.poll(async () => (await calls(page, 'note_print')).length).toBe(1)
})

test('an exported page keeps a diagram on a light surface in the dark, and a height-only image', async ({
  page,
  context,
}) => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="teal"/></svg>'
  const picture = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  await createNote(page, 'Look', `${DIAGRAM}\n![Tall h:200](${picture})\n`)
  await mockExport(page, { export_begin: { id: 3, fileName: 'Look.html' } })
  await pickFromNoteMenu(page, 'Look', 'Export as HTML…')
  await expect
    .poll(async () => (await calls(page, 'export_write')).length, { timeout: 20_000 })
    .toBe(1)
  const html = ((await calls(page, 'export_write'))[0]!.args as { text: string }).text

  const view = await context.newPage()
  await view.emulateMedia({ colorScheme: 'dark' })
  await view.setViewportSize({ width: 160, height: 600 })
  await view.setContent(html, { waitUntil: 'load' })
  type Style = Record<string, string>
  const computed = (selector: string) =>
    view
      .locator(selector)
      .first()
      .evaluate((el) => {
        const style = (
          globalThis as unknown as { getComputedStyle(e: unknown): Style }
        ).getComputedStyle(el)
        const box = (
          el as unknown as { getBoundingClientRect(): { height: number } }
        ).getBoundingClientRect()
        return { background: style['backgroundColor']!, height: box.height }
      })
  const channels = (color: string) => (color.match(/\d+/g) ?? []).slice(0, 3).map(Number)
  const diagram = await computed('.island svg')
  expect(Math.min(...channels(diagram.background))).toBeGreaterThan(200)
  expect((await computed('img')).height).toBeCloseTo(200, 0)
  const overflow = await view
    .locator('.island')
    .first()
    .evaluate((el) => {
      const box = el as unknown as { scrollWidth: number; clientWidth: number }
      return box.scrollWidth - box.clientWidth
    })
  expect(overflow).toBeLessThanOrEqual(0)
  await view.close()
})

test('Print right after the preview opens draws every diagram', async ({ page }) => {
  const sequence = '```mermaid\nsequenceDiagram\n  Alice->>Bob: Hello\n```\n'
  await createNote(page, 'Charts', `${DIAGRAM}\n${sequence}`)
  await mockExport(page)
  // The preview asks for both diagrams; the page for printing asks again at once.
  await page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Split' })
    .click()
  await pickFromNoteMenu(page, 'Charts', 'Print…')
  await confirmPageSetup(page, 'Print…')
  await expect
    .poll(async () => (await calls(page, 'note_print')).length, { timeout: 20_000 })
    .toBe(1)
  const printed = (await calls(page, 'note_print'))[0]!.args as { html: string }
  expect(printed.html.match(/<div class="island island-mermaid"><svg/g)).toHaveLength(2)
  expect(printed.html).not.toContain('language-mermaid')
})

test('a page to print loads nothing from the web: its images from there print as links', async ({
  page,
  context,
}) => {
  // A local listener stands in for an image host: printing must never reach it.
  let requests = 0
  const server = createServer((_request, response) => {
    requests += 1
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const remote = `http://127.0.0.1:${(server.address() as AddressInfo).port}/pixel.png`
  try {
    await createNote(page, 'Plan', `${BODY}\n![Pixel](${remote})\n`)
    await mockExport(page, { export_begin: { id: 3, fileName: 'Plan.html' } })
    await pickFromNoteMenu(page, 'Plan', 'Print…')
    await confirmPageSetup(page, 'Print…')
    await expect.poll(async () => (await calls(page, 'note_print')).length).toBe(1)
    await pickFromNoteMenu(page, 'Plan', 'Export as PDF…')
    await confirmPageSetup(page, 'Export…')
    await expect.poll(async () => (await calls(page, 'export_pdf')).length).toBe(1)
    const printed = [...(await calls(page, 'note_print')), ...(await calls(page, 'export_pdf'))]
    for (const call of printed) {
      const { html, images } = call.args as { html: string; images: { fileId: string }[] }
      expect(html).toContain(
        `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`,
      )
      expect(html).toContain(`<a href="${remote}">Pixel</a>`)
      expect(html).not.toContain(`src="${remote}"`)
      expect(images.map((i) => i.fileId)).toEqual([FILE])
      // Laid out in a web view of its own, as Rust prints it.
      const view = await context.newPage()
      await view.setContent(html, { waitUntil: 'load' })
      await expect(view.getByRole('link', { name: 'Pixel' })).toBeVisible()
      await view.close()
    }
    expect(requests).toBe(0)

    await pickFromNoteMenu(page, 'Plan', 'Export as HTML…')
    await expect.poll(async () => (await calls(page, 'export_write')).length).toBe(1)
    const exported = ((await calls(page, 'export_write'))[0]!.args as { text: string }).text
    expect(exported).toContain(`<img src="${remote}" alt="Pixel"`)
    expect(exported).toContain('img-src data: https: http:')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('a cancelled panel writes nothing and shows nothing', async ({ page }) => {
  // A failure logs its code, even when a later action's start hides its notice.
  const failures: string[] = []
  page.on('console', (message) => {
    if (message.text().includes('W_EXPORT_FAILED')) failures.push(message.text())
  })
  await createNote(page, 'Plan', BODY)
  const exportsWritten = async () =>
    (await calls(page, 'export_write')).map((c) => (c.args as { path: string }).path)
  for (const [item, file] of [
    ['Export as Markdown…', 'Plan.md'],
    ['Export as HTML…', 'Plan.html'],
  ] as const) {
    await page.evaluate(() => {
      const w = globalThis as unknown as TestWindow
      w.devotIpcCalls.length = 0
    })
    await mockExport(page, { export_begin: null })
    await pickFromNoteMenu(page, 'Plan', item)
    await expect.poll(async () => (await calls(page, 'export_begin')).length).toBe(1)
    // The same export again, saved this time: only the second one wrote (the cancelled one is long over).
    await mockExport(page, { export_begin: { id: 4, fileName: file } })
    await pickFromNoteMenu(page, 'Plan', item)
    await expect
      .poll(async () => (await calls(page, 'export_finish')).length, { timeout: 20_000 })
      .toBe(1)
    expect(await exportsWritten()).toEqual([file])
    expect((await calls(page, 'export_finish')).map((c) => c.args)).toEqual([{ id: 4 }])
    await expect(page.getByRole('alert')).toHaveCount(0)
  }

  // Print… and Export as PDF… answer false when the panel was cancelled.
  await mockExport(page, { note_print: false, export_pdf: false })
  await pickFromNoteMenu(page, 'Plan', 'Print…')
  await confirmPageSetup(page, 'Print…')
  await pickFromNoteMenu(page, 'Plan', 'Export as PDF…')
  await confirmPageSetup(page, 'Export…')
  await expect.poll(async () => (await calls(page, 'export_pdf')).length).toBe(1)
  await pickFromNoteMenu(page, 'Plan', 'Copy as HTML')
  await expect.poll(async () => (await calls(page, 'clipboard_write_html')).length).toBe(1)
  expect((await calls(page, 'note_print')).length).toBe(1)
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(failures).toEqual([])
})

test('a failure shows what did not complete, with its code, until dismissed', async ({ page }) => {
  await createNote(page, 'Plan', BODY)
  await mockExport(page, { export_write: { error: 'E_EXPORT_WRITE_FAILED' } })
  await pickFromNoteMenu(page, 'Plan', 'Export as Markdown…')
  const notice = page.getByRole('alert')
  await expect(notice).toContainText('The export did not complete (E_EXPORT_WRITE_FAILED).')
  expect((await calls(page, 'export_finish')).length).toBe(1)
  await notice.getByRole('button', { name: 'Dismiss' }).click()
  await expect(notice).toHaveCount(0)

  await mockExport(page, { note_print: { error: 'E_PRINT_BUSY' } })
  await pickFromNoteMenu(page, 'Plan', 'Print…')
  await confirmPageSetup(page, 'Print…')
  await expect(notice).toHaveText(/^The note could not be printed \(E_PRINT_BUSY\)\./)

  await mockExport(page, { clipboard_write_html: { error: 'E_CLIPBOARD_WRITE_FAILED' } })
  await pickFromNoteMenu(page, 'Plan', 'Copy as Simple HTML')
  await expect(notice).toHaveText(/^The note could not be copied \(E_CLIPBOARD_WRITE_FAILED\)\./)

  // A PDF that could not be written fails (there is no panel to cancel).
  await mockExport(page, { export_pdf: { error: 'E_EXPORT_PDF_FAILED' } })
  await pickFromNoteMenu(page, 'Plan', 'Export as PDF…')
  await confirmPageSetup(page, 'Export…')
  await expect(notice).toHaveText(/^The export did not complete \(E_EXPORT_PDF_FAILED\)\./)
})

test('an export that wrote the note but not one image says what is missing', async ({ page }) => {
  await createNote(page, 'Plan', BODY)
  await mockExport(page, { export_attach: { error: 'E_EXPORT_ATTACH_FAILED' } })
  await pickFromNoteMenu(page, 'Plan', 'Export as Markdown…')
  await expect(page.getByRole('alert')).toHaveText(
    /^The export is incomplete: 1 written, 1 with problems \(first: E_EXPORT_ATTACH_FAILED\)\./,
  )
  expect((await calls(page, 'export_write')).length).toBe(1)
})

test("an export's notice and a backup's both show, each with its buttons", async ({ page }) => {
  await createNote(page, 'Plan', BODY)
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      dispatchEvent(e: unknown): void
      CustomEvent: new (t: string, init: { detail: string }) => unknown
    }
    w.dispatchEvent(new w.CustomEvent('devot:backup-failed', { detail: 'E_BACKUP_DIR' }))
  })
  await mockExport(page, { export_write: { error: 'E_EXPORT_WRITE_FAILED' } })
  await pickFromNoteMenu(page, 'Plan', 'Export as Markdown…')
  const backup = page.getByRole('alert').filter({ hasText: 'E_BACKUP_DIR' })
  const exported = page.getByRole('alert').filter({ hasText: 'E_EXPORT_WRITE_FAILED' })
  await expect(backup).toBeVisible()
  await expect(exported).toBeVisible()
  // Neither covers the other: each one's Dismiss takes a click.
  await backup.getByRole('button', { name: 'Dismiss' }).click({ timeout: 5_000 })
  await expect(backup).toHaveCount(0)
  await expect(exported).toBeVisible()
  await exported.getByRole('button', { name: 'Dismiss' }).click({ timeout: 5_000 })
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('Copy as Simple HTML of an empty note copies nothing, without a notice', async ({ page }) => {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(1)
  await titleField(page).fill('Empty')
  await expect(noteRow(page, 'Empty')).toHaveCount(1)
  await mockExport(page)
  await pickFromNoteMenu(page, 'Empty', 'Copy as Simple HTML')
  await expect.poll(async () => (await calls(page, 'clipboard_write_html')).length).toBe(1)
  expect((await calls(page, 'clipboard_write_html'))[0]!.args).toEqual({ html: '', images: [] })
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test("a notebook's menu exports it with its sub-notebooks, as Markdown or HTML", async ({
  page,
}) => {
  for (const name of ['Work', 'Plans']) {
    await page.getByRole('button', { name: 'New Notebook' }).click()
    const field = page.getByRole('textbox', { name: 'Notebook name' })
    await field.fill(name)
    await field.press('Enter')
    await expect(bookRow(page, name)).toBeVisible()
  }
  await bookRow(page, 'Plans').dragTo(bookRow(page, 'Work'))
  await bookRow(page, 'Plans').click()
  await createNote(page, 'Plan', BODY)
  const planId = await noteId(page, 'Plan')
  await bookRow(page, 'Work').click()
  await createNote(page, 'Inbox', `# Inbox\n\n[Plan](devot://note/${planId})\n`)
  const inboxId = await noteId(page, 'Inbox')
  await bookRow(page, 'Plans').click()
  await noteRow(page, 'Plan').click()
  await body(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText(`\n[Inbox](devot://note/${inboxId})\n`)
  await mockExport(page, { export_begin: { id: 9, fileName: null } })

  const openBookMenu = async () => {
    const before = await popups(page)
    await bookRow(page, 'Work').click({ button: 'right' })
    await expect.poll(() => popups(page)).toBe(before + 1)
  }
  await openBookMenu()
  await pickMenuItem(page, 'as Markdown…', 'Export')
  await expect.poll(async () => (await calls(page, 'export_finish')).length).toBe(1)
  expect((await calls(page, 'export_begin'))[0]?.args).toEqual({
    kind: 'notebook',
    format: 'markdown',
    name: 'Work',
  })
  const written = (await calls(page, 'export_write')).map((c) => c.args as Record<string, string>)
  expect(written.map((w) => w['path'])).toEqual(['Inbox.md', 'Plans/Plan.md'])
  expect(written[1]!['text']).toContain('![Board](../attachments/board.png)')

  await openBookMenu()
  await pickMenuItem(page, 'as HTML…', 'Export')
  await expect.poll(async () => (await calls(page, 'export_finish')).length).toBe(2)
  const pages = (await calls(page, 'export_write')).slice(2).map((c) => c.args)
  expect(pages.map((p) => (p as Record<string, string>)['path'])).toEqual([
    'Inbox.html',
    'Plans/Plan.html',
  ])
  const [inbox, plan] = pages.map((p) => (p as Record<string, string>)['text']!)
  expect(inbox).toContain('<a href="Plans/Plan.html">Plan</a>')
  expect(plan).toContain('<a href="../Inbox.html">Inbox</a>')
})

test('Export All Notes writes every notebook as a folder, from the palette and File > Export', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  const field = page.getByRole('textbox', { name: 'Notebook name' })
  await field.fill('Work')
  await field.press('Enter')
  await bookRow(page, 'Work').click()
  await createNote(page, 'Plan', '# Plan\n\nText.\n')
  await mockExport(page, { export_begin: { id: 9, fileName: null } })

  await page.keyboard.press('Meta+KeyK')
  const palette = page.getByRole('dialog', { name: 'Command Palette' })
  await palette
    .getByRole('combobox', { name: 'Command Palette' })
    .fill('export all notes as markdown')
  await expect(palette.getByRole('option').first()).toContainText('Export All Notes as Markdown')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await calls(page, 'export_finish')).length).toBe(1)
  expect((await calls(page, 'export_begin'))[0]?.args).toEqual({
    kind: 'notebook',
    format: 'markdown',
    name: 'Devot Notes',
  })
  const paths = async () =>
    (await calls(page, 'export_write')).map((c) => (c.args as Record<string, string>)['path'])
  expect(await paths()).toContain('Work/Plan.md')

  await page.evaluate(() =>
    globalThis.dispatchEvent(new CustomEvent('devot:export-all', { detail: 'html' })),
  )
  await expect.poll(async () => (await calls(page, 'export_finish')).length).toBe(2)
  expect((await calls(page, 'export_begin'))[1]?.args).toMatchObject({
    format: 'html',
    name: 'Devot Notes',
  })
  expect(await paths()).toContain('Work/Plan.html')
})

test('Export Selected Notes writes the selected notes side by side', async ({ page }) => {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  const field = page.getByRole('textbox', { name: 'Notebook name' })
  await field.fill('Work')
  await field.press('Enter')
  await bookRow(page, 'Work').click()
  await createNote(page, 'One', 'First.\n')
  await createNote(page, 'Two', 'Second.\n')
  await mockExport(page, { export_begin: { id: 9, fileName: null } })
  await noteRow(page, 'One').click()
  await noteRow(page, 'Two').click({ modifiers: ['Meta'] })

  const before = await popups(page)
  await noteRow(page, 'Two').click({ button: 'right' })
  await expect.poll(() => popups(page)).toBe(before + 1)
  const menu = await shownMenu(page)
  expect(menu).toContain('Export Selected Notes as Markdown…')
  expect(menu).toContain('Export Selected Notes as HTML…')
  expect(menu).not.toContain('Print…')
  await pickMenuItem(page, 'Export Selected Notes as Markdown…')
  await expect.poll(async () => (await calls(page, 'export_finish')).length).toBe(1)
  expect((await calls(page, 'export_begin'))[0]?.args).toEqual({
    kind: 'notebook',
    format: 'markdown',
    name: 'Devot Export',
  })
  const written = (await calls(page, 'export_write')).map(
    (c) => (c.args as Record<string, string>)['path'],
  )
  expect([...written].sort()).toEqual(['One.md', 'Two.md'])
})

test('a page setup that cannot be saved stops the print and names the code', async ({ page }) => {
  await createNote(page, 'Plan', BODY)
  await mockExport(page, { editor_settings_set: { error: 'E_EDITOR_SETTINGS_WRITE_FAILED' } })
  await pickFromNoteMenu(page, 'Plan', 'Print…')
  await confirmPageSetup(page, 'Print…')
  // Rust lays the page out by the setup it holds: printing with the old one silently is worse (A114).
  await expect(page.getByRole('alert')).toContainText(
    'The note could not be printed (E_EDITOR_SETTINGS_WRITE_FAILED).',
  )
  expect(await calls(page, 'note_print')).toHaveLength(0)
})
