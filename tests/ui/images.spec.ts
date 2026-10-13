import type { Page } from '@playwright/test'
import {
  changeEditorSettingsElsewhere,
  changeShortcutsElsewhere,
  expect,
  pickMenuItem,
  shownMenu,
  test,
  type IpcCall,
  type TestWindow,
} from './fixtures'

// Images in the editor and the preview: previews under their lines, size
// presets, the viewer, the image context menu and the image commands.
// Attachments (devot://file) do not load in Playwright's browser; an image at a
// path on the page's own origin (routed here) does, and the preview treats it as
// local (images from the web become placeholders), so the viewer is checked with
// one. Editor keys
// are platform-neutral; the palette opens with Meta+P like in the other specs.

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const preview = (page: Page) => page.getByRole('article', { name: 'Preview' })
const viewer = (page: Page) => page.getByRole('dialog', { name: /^Image Viewer/ })
const viewerImage = (page: Page) => viewer(page).locator('img')
const inlineImages = (page: Page) => page.locator('.cm-inline-images')
const palette = (page: Page) => page.getByRole('dialog', { name: 'Command Palette' })
const field = (page: Page) => palette(page).getByRole('combobox', { name: 'Command Palette' })
const commands = (page: Page) =>
  palette(page).getByRole('listbox', { name: 'Results' }).getByRole('option')

const FILE_ID = '0192a6f0-0000-7000-8000-00000000f001'
const FILE = `devot://file/${FILE_ID}`
const BIG_SIZE = { width: 2400, height: 1600 }
const BIG = '/test-images/big.svg'

async function showMode(page: Page, name: 'Edit' | 'Split' | 'Preview') {
  await page.getByRole('group', { name: 'View mode' }).getByRole('button', { name }).click()
}

async function newNote(page: Page, text: string) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await body(page).click()
  await page.keyboard.insertText(text)
}

const calls = (page: Page, cmd: string) =>
  page.evaluate(
    (name) =>
      (globalThis as unknown as TestWindow).devotIpcCalls
        .filter((c: IpcCall) => c.cmd === name)
        .map((c: IpcCall) => c.args),
    cmd,
  )

const popups = async (page: Page) => (await calls(page, 'plugin:menu|popup')).length

async function runFromPalette(page: Page, name: string) {
  await page.keyboard.press('Meta+KeyP')
  await expect(field(page)).toBeFocused()
  await field(page).fill(name)
  const option = commands(page).filter({ hasText: name }).first()
  await expect(option).toBeVisible()
  await option.click()
  await expect(palette(page)).toBeHidden()
}

test.beforeEach(async ({ page }) => {
  await page.route(`**${BIG}`, (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="${BIG_SIZE.width}" height="${BIG_SIZE.height}"><rect width="100%" height="100%" fill="teal"/></svg>`,
    }),
  )
  await page.goto('/')
  await page.evaluate(() => {
    localStorage.clear()
    ;(globalThis as unknown as TestWindow).devotIpcMocks = { image_copy: null, image_save: true }
  })
  await page.reload()
  await page.evaluate(() => {
    ;(globalThis as unknown as TestWindow).devotIpcMocks = { image_copy: null, image_save: true }
  })
})

test('double-clicking a preview image opens the viewer, fitted to the window', async ({ page }) => {
  await newNote(page, `Look:\n\n![Big picture](${BIG})\n`)
  await showMode(page, 'Preview')
  const img = preview(page).locator('img')
  await expect
    .poll(() => img.evaluate((i) => (i as unknown as { naturalWidth: number }).naturalWidth))
    .toBe(BIG_SIZE.width)
  await img.dblclick()

  await expect(viewer(page)).toBeVisible()
  await expect(viewer(page)).toHaveAccessibleName('Image Viewer: Big picture')
  await expect(viewer(page).getByRole('button', { name: 'Close' })).toBeFocused()
  await expect(viewerImage(page)).toHaveAttribute('src', new RegExp(`${BIG}$`))
  await expect(viewerImage(page)).toHaveAttribute('alt', 'Big picture')
  const fit = viewer(page).getByRole('button', { name: 'Fit to Window' })
  const actual = viewer(page).getByRole('button', { name: 'Actual Size' })
  await expect(fit).toHaveAttribute('aria-pressed', 'true')
  await expect(actual).toHaveAttribute('aria-pressed', 'false')
  // The viewer covers the title bar: its first control clears the window
  // controls (which end at 70 px in the real window).
  expect((await fit.boundingBox())!.x).toBeGreaterThanOrEqual(80)

  // Fitted: the whole image shows inside the window, its shape kept.
  const window = page.viewportSize()!
  const fitted = (await viewerImage(page).boundingBox())!
  expect(fitted.width).toBeLessThanOrEqual(window.width)
  expect(fitted.height).toBeLessThanOrEqual(window.height)
  expect(fitted.width / fitted.height).toBeCloseTo(BIG_SIZE.width / BIG_SIZE.height, 1)

  // Actual size: pixel for pixel, scrolling inside the viewer.
  await actual.click()
  await expect(actual).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await viewerImage(page).boundingBox())?.width).toBe(BIG_SIZE.width)
  const stage = viewer(page).locator('.image-viewer-stage')
  expect(
    await stage.evaluate((s) => {
      const el = s as unknown as { scrollWidth: number; clientWidth: number }
      return el.scrollWidth > el.clientWidth
    }),
  ).toBe(true)

  // Clicking the image switches back.
  await viewerImage(page).click()
  await expect(fit).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await viewerImage(page).boundingBox())?.width).toBe(fitted.width)
})

test('the viewer keeps the keyboard, and Escape gives it back', async ({ page }) => {
  await newNote(page, `![Big](${BIG})`)
  await showMode(page, 'Preview')
  await preview(page).locator('img').dblclick()
  await expect(viewer(page)).toBeVisible()

  // Tab goes round the viewer's controls only.
  const insideViewer = () =>
    page.evaluate(() => {
      const d = globalThis as unknown as {
        document: { activeElement: { closest(s: string): unknown } | null }
      }
      return d.document.activeElement?.closest('dialog.image-viewer') != null
    })
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press('Tab')
    expect(await insideViewer()).toBe(true)
  }
  // Space on the focused zoom button switches to the actual size.
  await viewer(page).getByRole('button', { name: 'Actual Size' }).focus()
  await page.keyboard.press('Space')
  await expect(viewer(page).getByRole('button', { name: 'Actual Size' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  await page.keyboard.press('Escape')
  await expect(viewer(page)).toBeHidden()
  await expect(preview(page)).toBeFocused()

  // Close does the same.
  await preview(page).locator('img').dblclick()
  await viewer(page).getByRole('button', { name: 'Close' }).click()
  await expect(viewer(page)).toBeHidden()
})

test('the image menu copies and saves an attachment, and sets its size', async ({ page }) => {
  await newNote(page, `Before ![Shot](${FILE}) after`)
  await showMode(page, 'Split')
  const img = preview(page).locator('img')
  await expect(img).toHaveAttribute('src', FILE)

  const before = await popups(page)
  await img.click({ button: 'right' })
  await expect.poll(() => popups(page)).toBe(before + 1)
  expect(await shownMenu(page)).toEqual([
    'Copy Image',
    'Save Image As…',
    '---',
    'Size >',
    '  Auto [x]',
    '  Small [ ]',
    '  Half Width [ ]',
    '  Full Width [ ]',
  ])

  await pickMenuItem(page, 'Copy Image')
  await expect.poll(() => calls(page, 'image_copy')).toEqual([{ id: FILE_ID }])
  await pickMenuItem(page, 'Save Image As…')
  await expect.poll(() => calls(page, 'image_save')).toEqual([{ id: FILE_ID }])

  await pickMenuItem(page, 'Small', 'Size')
  await expect(body(page)).toHaveText(`Before ![Shot](${FILE}#small) after`)
  await expect(img).toHaveClass('image-size-small')
  // The image still loads from the attachment's own address.
  await expect(img).toHaveAttribute('src', FILE)

  // The menu shows the size it has now; Auto takes it off again.
  await img.click({ button: 'right' })
  await expect.poll(() => popups(page)).toBe(before + 2)
  expect(await shownMenu(page)).toContain('  Small [x]')
  await pickMenuItem(page, 'Auto', 'Size')
  await expect(body(page)).toHaveText(`Before ![Shot](${FILE}) after`)
  await expect(img).not.toHaveClass(/image-size/)
})

test('size presets show in the preview and stay in the Markdown', async ({ page }) => {
  await newNote(
    page,
    `![a](${BIG}#small)\n\n![b](${BIG}#half)\n\n![c](${BIG}#full)\n\n![d](${BIG})`,
  )
  await showMode(page, 'Preview')
  const imgs = preview(page).locator('img')
  await expect(imgs).toHaveCount(4)
  const article = (await preview(page).locator('p').first().boundingBox())!
  const width = async (i: number) => (await imgs.nth(i).boundingBox())!.width
  // Auto's width comes from the loaded image, so measure only once all have loaded.
  for (let i = 0; i < 4; i += 1) {
    await expect
      .poll(() =>
        imgs.nth(i).evaluate((img) => (img as unknown as { naturalWidth: number }).naturalWidth),
      )
      .toBe(BIG_SIZE.width)
  }
  await expect.poll(() => width(0)).toBe(240)
  expect(await width(1)).toBeCloseTo(article.width / 2, 0)
  expect(await width(2)).toBeCloseTo(article.width, 0)
  // Auto: its own size, no wider than the page.
  expect(await width(3)).toBeCloseTo(article.width, 0)
  for (let i = 0; i < 4; i += 1) await expect(imgs.nth(i)).toHaveAttribute('src', BIG)
})

test('a remote image offers only its size, and one without a destination nothing', async ({
  page,
}) => {
  await newNote(page, `![Big](${BIG})\n\n![Ref][r]\n\n[r]: ${BIG}\n`)
  await showMode(page, 'Preview')
  const before = await popups(page)
  await preview(page).locator('img').first().click({ button: 'right' })
  await expect.poll(() => popups(page)).toBe(before + 1)
  expect(await shownMenu(page)).toEqual([
    'Size >',
    '  Auto [x]',
    '  Small [ ]',
    '  Half Width [ ]',
    '  Full Width [ ]',
  ])
  await pickMenuItem(page, 'Full Width', 'Size')
  await showMode(page, 'Edit')
  await expect(body(page)).toContainText(`![Big](${BIG}#full)`)

  // A reference image has no size of its own and no attachment: no menu.
  await showMode(page, 'Preview')
  await preview(page).locator('img').nth(1).click({ button: 'right' })
  await page.waitForTimeout(200)
  expect(await popups(page)).toBe(before + 1)
})

test('attachments show under their lines in the editor, unless turned off', async ({ page }) => {
  await newNote(page, `intro\n![Shot](${FILE}) and ![Two](${FILE})\nnext line\n![Remote](${BIG})`)
  await expect(inlineImages(page)).toHaveCount(1)
  await expect(inlineImages(page).locator('img')).toHaveCount(2)
  await expect(inlineImages(page).locator('img').first()).toHaveAttribute('src', FILE)
  // Under the image's line, above the next one, at its fixed height (so
  // nothing moves when the image loads or fails).
  const expectUnderShotLine = async () => {
    const line = (await page.locator('.cm-line').filter({ hasText: 'Shot' }).boundingBox())!
    const block = (await inlineImages(page).boundingBox())!
    const next = (await page.locator('.cm-line').filter({ hasText: 'next line' }).boundingBox())!
    expect(block.y).toBeGreaterThanOrEqual(line.y + line.height - 1)
    expect(next.y).toBeGreaterThanOrEqual(block.y + block.height - 1)
    expect(block.height).toBe(160)
    return block
  }
  const first = await expectUnderShotLine()

  // A line added above moves the preview down with its line.
  await page.locator('.cm-line').filter({ hasText: 'intro' }).click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('added above')
  await expect(page.locator('.cm-line').filter({ hasText: 'added above' })).toHaveCount(1)
  await expect(inlineImages(page)).toHaveCount(1)
  const moved = await expectUnderShotLine()
  expect(moved.y).toBeGreaterThan(first.y)

  await changeEditorSettingsElsewhere(page, { inlineImages: false })
  await expect(inlineImages(page)).toHaveCount(0)
  await changeEditorSettingsElsewhere(page, {})
  await expect(inlineImages(page)).toHaveCount(1)
})

test('an image under its line has the image menu', async ({ page }) => {
  await newNote(page, `![Shot](${FILE})\n`)
  const img = inlineImages(page).locator('img')
  await expect(img).toHaveCount(1)
  const before = await popups(page)
  // Attachments do not load here, so the event goes to the image directly.
  await img.dispatchEvent('contextmenu', { clientX: 20, clientY: 20, bubbles: true })
  await expect.poll(() => popups(page)).toBe(before + 1)
  expect(await shownMenu(page)).toContain('Copy Image')
  await pickMenuItem(page, 'Half Width', 'Size')
  await expect(body(page)).toContainText(`![Shot](${FILE}#half)`)
  await pickMenuItem(page, 'Save Image As…')
  await expect.poll(() => calls(page, 'image_save')).toEqual([{ id: FILE_ID }])

  // Double-click opens the viewer here too.
  await img.dispatchEvent('dblclick', { bubbles: true })
  await expect(viewer(page)).toBeVisible()
  await expect(viewerImage(page)).toHaveAttribute('src', FILE)
  await page.keyboard.press('Escape')
  await expect(viewer(page)).toBeHidden()
  // The keyboard goes back into the editor.
  await expect(body(page)).toBeFocused()
})

test('an image dropped on an image under its line goes into the note', async ({ page }) => {
  await newNote(page, `![Shot](${FILE})\n`)
  const img = inlineImages(page).locator('img')
  await expect(img).toHaveCount(1)
  await img.evaluate((el) => {
    type Data = { items: { add(file: unknown): void } }
    const w = globalThis as unknown as {
      DataTransfer: new () => Data
      File: new (parts: unknown[], name: string, options: { type: string }) => unknown
      DragEvent: new (type: string, init: object) => unknown
    }
    const target = el as unknown as {
      getBoundingClientRect(): { left: number; top: number }
      dispatchEvent(event: unknown): boolean
    }
    const data = new w.DataTransfer()
    const png = [
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    ]
    data.items.add(new w.File([new Uint8Array(png)], 'Dropped.png', { type: 'image/png' }))
    const rect = target.getBoundingClientRect()
    target.dispatchEvent(
      new w.DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: data,
        clientX: rect.left + 2,
        clientY: rect.top + 2,
      }),
    )
  })
  await expect(body(page)).toContainText('![Dropped](devot://file/')
})

test('a key the user gives an image command acts on the image at the cursor', async ({ page }) => {
  await newNote(page, `intro\n![Shot](${FILE})`)
  // What Rust sends every window after Settings > Keyboard Shortcuts stores it.
  await changeShortcutsElsewhere(page, { 'image.sizeHalf': ['Mod+Alt+J'] })
  const shot = page.locator('.cm-line').filter({ hasText: 'Shot' })
  await shot.click()
  await page.keyboard.press('ControlOrMeta+Alt+KeyJ')
  await expect(shot).toHaveText(`![Shot](${FILE}#half)`)
  // Away from an image it does nothing.
  await page.locator('.cm-line').filter({ hasText: 'intro' }).click()
  await page.keyboard.press('ControlOrMeta+Alt+KeyJ')
  expect(await page.locator('.cm-line').allTextContents()).toEqual([
    'intro',
    `![Shot](${FILE}#half)`,
  ])
})

test('the palette runs the image commands for the image at the cursor', async ({ page }) => {
  await newNote(page, `intro\n![Shot](${FILE})`)
  await page.locator('.cm-line').filter({ hasText: 'Shot' }).click()
  await runFromPalette(page, 'Image Size: Half Width')
  await expect(page.locator('.cm-line').filter({ hasText: 'Shot' })).toHaveText(
    `![Shot](${FILE}#half)`,
  )
  await runFromPalette(page, 'Copy Image')
  await expect.poll(() => calls(page, 'image_copy')).toEqual([{ id: FILE_ID }])

  // Away from an image the palette does not offer them.
  await page.locator('.cm-line').filter({ hasText: 'intro' }).click()
  await page.keyboard.press('Meta+KeyP')
  await field(page).fill('Image Size')
  await expect(commands(page).filter({ hasText: 'Image Size' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(palette(page)).toBeHidden()
})
