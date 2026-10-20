import type { Page } from '@playwright/test'
import { expect, reloadApp, test, pickNoteMore } from './fixtures'

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })

// The first bytes of a PNG file: enough for format detection.
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]
const LINK = /!\[(.*?)\]\(devot:\/\/file\/([0-9a-f-]{36})\)/

async function newNote(page: Page) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await body(page).click()
}

async function sendFiles(
  page: Page,
  kind: 'paste' | 'drop',
  files: { name: string; type: string; bytes: number[]; size?: number }[],
) {
  await body(page).evaluate(
    (el, { kind: action, files: list }) => {
      // No DOM types in this config: the few browser classes used here.
      type Data = { items: { add(file: unknown): void } }
      const w = globalThis as unknown as {
        DataTransfer: new () => Data
        File: new (parts: unknown[], name: string, options: { type: string }) => unknown
        ClipboardEvent: new (type: string, init: object) => unknown
        DragEvent: new (type: string, init: object) => unknown
      }
      const target = el as unknown as {
        getBoundingClientRect(): { left: number; top: number }
        dispatchEvent(event: unknown): boolean
      }
      const data = new w.DataTransfer()
      for (const f of list) {
        const bytes = new Uint8Array(Math.max(f.size ?? 0, f.bytes.length))
        bytes.set(f.bytes)
        data.items.add(new w.File([bytes], f.name, { type: f.type }))
      }
      const rect = target.getBoundingClientRect()
      const init = { bubbles: true, cancelable: true }
      const event =
        action === 'paste'
          ? new w.ClipboardEvent('paste', { ...init, clipboardData: data })
          : new w.DragEvent('drop', {
              ...init,
              dataTransfer: data,
              clientX: rect.left + 5,
              clientY: rect.top + 5,
            })
      target.dispatchEvent(event)
    },
    { kind, files },
  )
}

const stored = (page: Page) =>
  page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('devot.test.files') ?? '[]') as {
        id: string
        noteId: string
        mime: string
        base64: string
      }[],
  )

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await reloadApp(page)
})

test('pasting an image stores it and inserts a devot://file link', async ({ page }) => {
  await newNote(page)
  await sendFiles(page, 'paste', [{ name: 'Screen Shot.png', type: 'image/png', bytes: PNG }])
  await expect(body(page)).toContainText('devot://file/')
  const match = LINK.exec((await body(page).textContent()) ?? '')
  expect(match?.[1]).toBe('Screen Shot')
  await expect.poll(async () => (await stored(page)).map((f) => f.id)).toEqual([match?.[2]])
  expect((await stored(page))[0]?.mime).toBe('image/png')

  await page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Split' })
    .click()
  await expect(page.getByRole('article', { name: 'Preview' }).locator('img')).toHaveAttribute(
    'src',
    `devot://file/${match?.[2]}`,
  )
})

test('dropping images inserts one link per image', async ({ page }) => {
  await newNote(page)
  await sendFiles(page, 'drop', [
    { name: 'a.png', type: 'image/png', bytes: PNG },
    { name: 'b.png', type: 'image/png', bytes: PNG },
  ])
  await expect.poll(async () => (await stored(page)).length).toBe(2)
  await expect(body(page)).toContainText('![a](devot://file/')
  await expect(body(page)).toContainText('![b](devot://file/')
})

test('a pasted image is one undo step, apart from the typing around it', async ({ page }) => {
  await newNote(page)
  await page.keyboard.type('Before ')
  await sendFiles(page, 'paste', [{ name: 'Shot.png', type: 'image/png', bytes: PNG }])
  await expect(body(page)).toContainText('devot://file/')
  await page.keyboard.type(' after')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(body(page)).not.toContainText('after')
  await expect(body(page)).toContainText('devot://file/')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(body(page)).not.toContainText('devot://file/')
  await expect(body(page)).toContainText('Before')
})

test('a file that only claims to be an image is refused', async ({ page }) => {
  await newNote(page)
  await sendFiles(page, 'paste', [
    {
      name: 'evil.png',
      type: 'image/png',
      bytes: [...new TextEncoder().encode('<svg onload=alert(1)>')],
    },
  ])
  // The refusal is reported: the app acted on the file before the checks below.
  await expect(page.getByRole('alert')).toHaveText(/\(E_FILE_TYPE_REFUSED\)/)
  await expect(body(page)).not.toContainText('devot://file/')
  expect(await stored(page)).toEqual([])
})

test('images that could not be stored are reported in a notice, with the code', async ({
  page,
}) => {
  await newNote(page)
  const refused = (name: string) => ({
    name,
    type: 'image/png',
    bytes: [...new TextEncoder().encode('<svg onload=alert(1)>')],
  })
  await sendFiles(page, 'paste', [
    { name: 'Shot.png', type: 'image/png', bytes: PNG },
    refused('evil.png'),
  ])
  await expect.poll(async () => (await stored(page)).length).toBe(1)
  await expect(body(page)).toContainText('devot://file/')
  const notice = page.getByRole('alert').filter({ hasText: 'could not be added' })
  await expect(notice).toHaveText(/^An image could not be added \(E_FILE_TYPE_REFUSED\)\./)
  await notice.getByRole('button', { name: 'Dismiss' }).click()
  await expect(notice).toHaveCount(0)

  await sendFiles(page, 'drop', [refused('a.png'), refused('b.png')])
  await expect(notice).toHaveText(/^2 images could not be added \(E_FILE_TYPE_REFUSED\)\./)
})

test('an SVG, a TIFF and an oversized image are refused with a notice, the rest is added', async ({
  page,
}) => {
  await newNote(page)
  const notice = page.getByRole('alert').filter({ hasText: 'could not be added' })
  await sendFiles(page, 'drop', [
    {
      name: 'logo.svg',
      type: 'image/svg+xml',
      bytes: [...new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    },
  ])
  await expect(notice).toHaveText(/^An image could not be added \(E_FILE_TYPE_REFUSED\)\./)
  await notice.getByRole('button', { name: 'Dismiss' }).click()

  await sendFiles(page, 'paste', [
    { name: 'scan.tiff', type: 'image/tiff', bytes: [0x49, 0x49, 0x2a, 0] },
    // One byte over 10 MiB.
    { name: 'huge.png', type: 'image/png', bytes: PNG, size: 10 * 1024 * 1024 + 1 },
    { name: 'Shot.png', type: 'image/png', bytes: PNG },
  ])
  await expect(notice).toHaveText(/^2 images could not be added \(E_FILE_/)
  await expect(body(page)).toContainText('![Shot](devot://file/')
  await expect(body(page)).not.toContainText('huge')
  expect((await stored(page)).map((f) => f.mime)).toEqual(['image/png'])
})

test('an image lands where it was pasted, however the text changed during the upload', async ({
  page,
}) => {
  await newNote(page)
  await page.evaluate(() => localStorage.setItem('devot.test.delayFileWrites', 'hold'))
  await page.keyboard.type('Before ')
  await sendFiles(page, 'paste', [{ name: 'Shot.png', type: 'image/png', bytes: PNG }])
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.type('Top. ')
  await expect(body(page)).toHaveText('Top. Before ')
  await page.evaluate(() => localStorage.removeItem('devot.test.delayFileWrites'))
  await expect(body(page)).toContainText('devot://file/')
  expect(await body(page).textContent()).toMatch(
    /^Top\. Before !\[Shot\]\(devot:\/\/file\/[0-9a-f-]{36}\)$/,
  )
  // The caret was not at the paste, so it stays where it is.
  await page.keyboard.type('X')
  expect(await body(page).textContent()).toMatch(/^Top\. XBefore !\[Shot\]/)
})

test('an image whose note was left during the upload is linked in that note', async ({ page }) => {
  await newNote(page)
  await page.getByRole('textbox', { name: 'Title' }).fill('Alpha')
  await body(page).click()
  await page.evaluate(() => localStorage.setItem('devot.test.delayFileWrites', '700'))
  await page.keyboard.type('Alpha text ')
  await sendFiles(page, 'paste', [{ name: 'Shot.png', type: 'image/png', bytes: PNG }])

  await newNote(page)
  await page.getByRole('textbox', { name: 'Title' }).fill('Beta')
  await expect.poll(async () => (await stored(page)).length).toBe(1)
  const [file] = await stored(page)
  const link = `![Shot](devot://file/${file?.id})`
  await expect(body(page)).not.toContainText('devot://file/')

  await noteRows(page).filter({ hasText: 'Alpha' }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Alpha')
  await expect(body(page)).toHaveText(`Alpha text ${link}`)
  // And it is saved, not only shown.
  await noteRows(page).filter({ hasText: 'Beta' }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Beta')
  await noteRows(page).filter({ hasText: 'Alpha' }).click()
  await expect(body(page)).toHaveText(`Alpha text ${link}`)
})

test('Duplicate gives the copy its own image file, shown under a new ID', async ({ page }) => {
  await newNote(page)
  await sendFiles(page, 'paste', [{ name: 'Shot.png', type: 'image/png', bytes: PNG }])
  await expect.poll(async () => (await stored(page)).length).toBe(1)
  const [original] = await stored(page)
  await expect(body(page)).toContainText(`devot://file/${original?.id}`)

  await noteRows(page).first().click()
  await page.keyboard.press('Meta+KeyD')
  await expect(noteRows(page)).toHaveCount(2)
  await expect.poll(async () => (await stored(page)).length).toBe(2)
  const copy = (await stored(page)).find((f) => f.id !== original?.id)
  expect(copy?.noteId).not.toBe(original?.noteId)
  expect(copy).toMatchObject({ mime: 'image/png', base64: original?.base64 })
  await expect(body(page)).toContainText(`![Shot](devot://file/${copy?.id})`)
  await expect(body(page)).not.toContainText(`${original?.id}`)
})

test('an image another note shows stays when its own note is deleted for good', async ({
  page,
}) => {
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' })
  const trashRow = sidebar.getByRole('button', { name: /^Trash \d+$/ })
  await newNote(page)
  await page.getByRole('textbox', { name: 'Title' }).fill('Source')
  await body(page).click()
  await sendFiles(page, 'paste', [{ name: 'Shot.png', type: 'image/png', bytes: PNG }])
  await expect.poll(async () => (await stored(page)).length).toBe(1)
  const [file] = await stored(page)
  const link = `![Shot](devot://file/${file?.id})`
  await expect(body(page)).toContainText(link)

  await newNote(page)
  await page.keyboard.insertText(`Shown here too: ${link}`)
  await expect(body(page)).toContainText(link)

  await noteRows(page).filter({ hasText: 'Source' }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Source')
  await pickNoteMore(page, 'Move to Trash')
  await expect(trashRow).toHaveText(/1$/)
  await trashRow.click()
  await page.getByRole('button', { name: 'Empty Trash' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Empty Trash' }).click()
  await expect(trashRow).toHaveText(/0$/)

  const notes = () =>
    page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as {
          id: string
          bodyMd: string
          purgedAt?: number
        }[],
    )
  const other = (await notes()).find((n) => n.purgedAt === undefined && n.bodyMd.includes(link))
  expect(other).toBeDefined()
  await expect
    .poll(async () => (await stored(page)).map((f) => [f.id, f.noteId]))
    .toEqual([[file?.id, other?.id]])
})
