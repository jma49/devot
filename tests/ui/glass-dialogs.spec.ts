import type { Locator, Page } from '@playwright/test'
import { expect, pickMenuItem, pickNoteMore, test, type TestWindow } from './fixtures'

const FOLDERS = ['Inbox', 'Projects', 'Projects/Deep', 'Areas', 'Resources', 'Archive', 'Daily']
const SCAN = {
  id: 7,
  name: 'Vault',
  kind: 'folder',
  files: [...FOLDERS, 'Journal', 'People', 'Reading', 'Travel'].map((folder) => ({
    path: `${folder}/Note.md`,
    bytes: 2048,
  })),
  images: [],
  skipped: [],
}

const importSheet = (page: Page) => page.getByRole('dialog', { name: 'Import Markdown Folder' })
const importTree = (page: Page) => importSheet(page).getByRole('list', { name: 'Folders found' })
const cancelButton = (dialog: Locator) => dialog.getByRole('button', { name: 'Cancel' })
const treeRows = (page: Page) => importTree(page).locator('.import-folder-row')

// Dialogs scale in, so a box measured before the animation ends comes out fractional.
async function settled(dialog: Locator) {
  await expect(dialog).toBeVisible()
  await dialog.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
}

async function start(page: Page, glass: boolean) {
  await page.addInitScript((sidebarMaterial) => {
    const w = globalThis as unknown as TestWindow & { devotInitialEditorSettings: unknown }
    w.devotInitialEditorSettings = { revision: 0, settings: { sidebarMaterial } }
    w.devotIpcMocks = { editor_settings_get: () => new Promise(() => {}) }
  }, glass)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'New Note', exact: true })).toBeEnabled()
}

async function openImport(page: Page, glass: boolean) {
  await start(page, glass)
  await page.evaluate((scan) => {
    const w = globalThis as unknown as {
      dispatchEvent(e: unknown): void
      CustomEvent: new (t: string, init: { detail: unknown }) => unknown
    }
    w.dispatchEvent(
      new w.CustomEvent('devot:import-scanning', {
        detail: { id: 7, name: 'Vault', kind: 'folder' },
      }),
    )
    w.dispatchEvent(new w.CustomEvent('devot:import-ready', { detail: scan }))
  }, SCAN)
  await expect(importTree(page)).toBeVisible()
  await settled(importSheet(page))
}

async function openConfirm(page: Page, glass: boolean) {
  await start(page, glass)
  const name = page.getByRole('textbox', { name: 'Notebook name' })
  await page.getByRole('button', { name: 'New Notebook' }).click()
  await name.fill('Work')
  await name.press('Enter')
  const book = page
    .getByRole('tree', { name: 'Notebooks' })
    .getByRole('treeitem', { name: /^Work\b/ })
    .locator('> .book-row')
  await book.click({ button: 'right' })
  await pickMenuItem(page, 'Delete Notebook')
  const dialog = page.getByRole('dialog', { name: 'Delete the notebook \u201cWork\u201d?' })
  await settled(dialog)
  return dialog
}

// Resetting shortcuts loses nothing that matters: a confirm that keeps the plain layout.
async function openPlainConfirm(page: Page) {
  await page.addInitScript(() => {
    const w = globalThis as unknown as TestWindow & { devotInitialEditorSettings: unknown }
    w.devotInitialEditorSettings = { revision: 0, settings: { sidebarMaterial: true } }
    w.devotIpcMocks = { editor_settings_get: () => new Promise(() => {}) }
  })
  await page.goto('/settings.html')
  await page.getByRole('tab', { name: 'Keyboard', exact: true }).click()
  const italic = page.getByRole('button', { name: /^Italic shortcut/ })
  await italic.click()
  await expect(italic).toHaveText('Type Shortcut\u2026')
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Alt+J`)
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Reset All Shortcuts\u2026' }).click()
  const dialog = page.getByRole('dialog', { name: 'Reset every shortcut to its default?' })
  await settled(dialog)
  return dialog
}

async function openLinkDialog(page: Page, glass: boolean) {
  await start(page, glass)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  const body = page.getByRole('textbox', { name: 'Note body' })
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await body.click()
  await page.keyboard.insertText('Read the docs today')
  await body.getByText('Read the docs today').dblclick({ position: { x: 50, y: 8 } })
  await page.getByRole('toolbar', { name: 'Format' }).getByRole('button', { name: 'Link' }).click()
  const dialog = page.getByRole('dialog', { name: 'Insert a link' })
  await settled(dialog)
  return dialog
}

const css = (locator: Locator, property: string) =>
  locator.evaluate((el, name) => getComputedStyle(el).getPropertyValue(name), property)
const backdropColor = (dialog: Locator) =>
  dialog.evaluate((el) => getComputedStyle(el, '::backdrop').backgroundColor)
const box = async (locator: Locator) => {
  const rect = await locator.boundingBox()
  if (!rect) throw new Error('E_TEST_NO_BOX')
  return rect
}
async function expectGlassSurface(dialog: Locator) {
  await expect(dialog).toHaveCSS('border-radius', '26px')
  expect(await css(dialog, 'backdrop-filter')).not.toBe('none')
  expect(await css(dialog, 'background-color')).toMatch(/rgba?\(.*0\.78\)|\/ 0\.78\)/)
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} Glass dialogs`, () => {
    test.use({ colorScheme, viewport: { width: 1000, height: 720 } })

    test('the import sheet is glass with an inset group and capsule buttons', async ({ page }) => {
      await openImport(page, true)
      const sheet = importSheet(page)
      await expectGlassSurface(sheet)
      await expect(sheet).toHaveCSS('padding', '12px')

      const tree = importTree(page)
      await expect(tree).toHaveCSS('border-radius', '14px')
      await expect(tree).toHaveCSS('overflow-y', 'auto')

      const rows = treeRows(page)
      expect((await box(rows.nth(1))).height).toBe(36)
      const nameLeft = (row: Locator) => box(row.locator('.import-folder-name'))
      const inProjects = rows.filter({ hasText: 'Deep' })
      const projects = rows.filter({ hasText: 'Projects' })
      expect((await nameLeft(inProjects)).x - (await nameLeft(projects)).x).toBeCloseTo(16, 0)
      await expect(rows.nth(1)).toHaveCSS('border-top-width', /0\.5px|1px/)
      await expect(rows.first()).toHaveCSS('border-top-width', '0px')

      const badge = rows.nth(1).locator('.import-badge')
      expect((await box(badge)).height).toBe(18)
      await expect(badge).toHaveCSS('border-radius', '999px')
      await expect(rows.nth(1).locator('.import-folder-counts')).toHaveCSS(
        'font-variant-numeric',
        'tabular-nums',
      )

      const cancel = cancelButton(sheet)
      const proceed = sheet.getByRole('button', { name: 'Continue' })
      expect((await box(cancel)).height).toBe(28)
      await expect(cancel).toHaveCSS('border-radius', '999px')
      await expect(proceed).toHaveCSS('border-radius', '999px')
      const sheetBox = await box(sheet)
      const proceedBox = await box(proceed)
      expect(sheetBox.x + sheetBox.width - (proceedBox.x + proceedBox.width)).toBeCloseTo(12, 0)
      expect(sheetBox.y + sheetBox.height - (proceedBox.y + proceedBox.height)).toBeCloseTo(12, 0)

      await expect(sheet.locator('.import-tree-summary')).toHaveText('11 notebooks \u00b7 11 notes')

      const titleLeft = (await box(sheet.locator('.sheet-title'))).x
      expect(titleLeft - sheetBox.x).toBeCloseTo(22, 0)
      expect((await box(tree)).x - sheetBox.x).toBeCloseTo(12, 0)
    })

    test('a tall tree scrolls inside its group, not the sheet', async ({ page }) => {
      await openImport(page, true)
      const tree = importTree(page)
      const sizes = await tree.evaluate((el) => ({
        client: el.clientHeight,
        full: el.scrollHeight,
      }))
      expect(sizes.full).toBeGreaterThan(sizes.client)
      expect(sizes.client).toBeLessThanOrEqual(36 * 7 + 7)
      const sheet = importSheet(page)
      const outer = await sheet.evaluate((el) => el.scrollHeight - el.clientHeight)
      expect(outer).toBe(0)
    })

    test('a confirm dialog shares the glass surface and capsule buttons', async ({ page }) => {
      const dialog = await openPlainConfirm(page)
      await expectGlassSurface(dialog)
      const cancel = cancelButton(dialog)
      expect((await box(cancel)).height).toBe(28)
      await expect(cancel).toHaveCSS('border-radius', '999px')
      const dialogBox = await box(dialog)
      const last = await box(dialog.locator('.confirm-actions .button').last())
      expect(dialogBox.x + dialogBox.width - (last.x + last.width)).toBeCloseTo(12, 0)
      expect(dialogBox.y + dialogBox.height - (last.y + last.height)).toBeCloseTo(12, 0)
    })

    test('a plain confirm has no icon tile and keeps its buttons in a row', async ({ page }) => {
      const dialog = await openPlainConfirm(page)
      await expect(dialog.locator('.confirm-icon')).toHaveCount(0)
      await expect(dialog.locator('.confirm-actions')).toHaveCSS('flex-direction', 'row')
      await expect(dialog).toHaveCSS('text-align', 'start')
    })

    test('a destructive confirm is a centred card with stacked capsules', async ({ page }) => {
      const dialog = await openConfirm(page, true)
      await expectGlassSurface(dialog)
      const card = await box(dialog)
      expect(card.width).toBe(300)
      await expect(dialog).toHaveCSS('padding', '22px 16px 16px')
      await expect(dialog).toHaveCSS('text-align', 'center')

      const tile = dialog.locator('.confirm-icon')
      const tileBox = await box(tile)
      expect(tileBox.width).toBe(52)
      expect(tileBox.height).toBe(52)
      expect(tileBox.x - card.x).toBeCloseTo((300 - 52) / 2, 0)
      await expect(tile).toHaveCSS('border-radius', '14px')
      await expect(tile.locator('[aria-hidden="true"]')).toHaveCount(1)
      await expect(tile).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')

      const cancel = cancelButton(dialog)
      const destructive = dialog.getByRole('button', { name: 'Delete Notebook' })
      const cancelBox = await box(cancel)
      const destructiveBox = await box(destructive)
      for (const button of [cancelBox, destructiveBox]) {
        expect(button.height).toBe(32)
        expect(button.width).toBe(268)
        expect(button.x - card.x).toBeCloseTo(16, 0)
      }
      expect(cancelBox.y - (destructiveBox.y + destructiveBox.height)).toBeCloseTo(8, 0)
      expect(card.y + card.height - (cancelBox.y + cancelBox.height)).toBeCloseTo(16, 0)
      await expect(cancel).toHaveCSS('border-radius', '999px')
      await expect(destructive).toHaveCSS('border-radius', '999px')
      await expect(destructive).toHaveCSS('background-color', 'rgb(196, 55, 47)')
      await expect(destructive).toHaveCSS('color', 'rgb(255, 255, 255)')
    })

    test('the link dialog is glass with capsule buttons', async ({ page }) => {
      const dialog = await openLinkDialog(page, true)
      await expectGlassSurface(dialog)
      const cancel = cancelButton(dialog)
      expect((await box(cancel)).height).toBe(28)
      await expect(cancel).toHaveCSS('border-radius', '999px')
      const dialogBox = await box(dialog)
      const last = await box(dialog.locator('.link-dialog-button').last())
      expect(dialogBox.x + dialogBox.width - (last.x + last.width)).toBeCloseTo(12, 0)
      expect(dialogBox.y + dialogBox.height - (last.y + last.height)).toBeCloseTo(12, 0)
    })
  })
}

test.describe('the keyboard in a destructive confirm', () => {
  async function openEmptyTrash(page: Page) {
    await start(page, true)
    await page.getByRole('button', { name: 'New Note', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
    await pickNoteMore(page, 'Move to Trash')
    await page
      .getByRole('navigation', { name: 'Sidebar' })
      .getByRole('button', { name: /^Trash \d+$/ })
      .click()
    await page.getByRole('button', { name: 'Empty Trash' }).click()
    const dialog = page.getByRole('dialog')
    await settled(dialog)
    return dialog
  }

  test('the buttons stay in document order though the action is drawn first', async ({ page }) => {
    const dialog = await openEmptyTrash(page)
    const buttons = dialog.locator('.confirm-actions .button')
    await expect(buttons.first()).toHaveText('Cancel')
    await expect(buttons.last()).toHaveText('Empty Trash')
    expect((await box(buttons.last())).y).toBeLessThan((await box(buttons.first())).y)
  })

  test('Cancel takes the keyboard, and Return declines', async ({ page }) => {
    const dialog = await openEmptyTrash(page)
    await expect(cancelButton(dialog)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('button', { name: 'Empty Trash' })).toBeEnabled()
  })

  test('Escape declines', async ({ page }) => {
    const dialog = await openEmptyTrash(page)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('button', { name: 'Empty Trash' })).toBeEnabled()
  })

  test('a notebook still gives the keyboard to the action', async ({ page }) => {
    const dialog = await openConfirm(page, true)
    await expect(dialog.getByRole('button', { name: 'Delete Notebook' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })
})

test.describe('the dim behind a dialog', () => {
  test.describe('dark', () => {
    test.use({ colorScheme: 'dark' })

    test('dims less in Glass than in Classic', async ({ page }) => {
      await openImport(page, true)
      expect(await backdropColor(importSheet(page))).toMatch(/0\.2\)$/)
    })

    test('stays as it was in Classic', async ({ page }) => {
      await openImport(page, false)
      expect(await backdropColor(importSheet(page))).toMatch(/0\.3\)$/)
    })
  })

  test.describe('light', () => {
    test.use({ colorScheme: 'light' })

    test('keeps its strength in Glass', async ({ page }) => {
      await openImport(page, true)
      expect(await backdropColor(importSheet(page))).toMatch(/0\.3\)$/)
    })
  })
})

test.describe('Classic dialogs stay as they were', () => {
  test.use({ colorScheme: 'light', viewport: { width: 1000, height: 720 } })

  test('the import sheet', async ({ page }) => {
    await openImport(page, false)
    const sheet = importSheet(page)
    await expect(sheet).toHaveCSS('border-radius', '8px')
    await expect(sheet).toHaveCSS('padding', '18px')
    expect(await css(sheet, 'backdrop-filter')).toBe('none')
    await expect(sheet).toHaveCSS('display', 'block')

    const tree = importTree(page)
    await expect(tree).toHaveCSS('border-radius', '0px')
    await expect(tree).toHaveCSS('border-top-width', '1px')
    const rows = treeRows(page)
    await expect(rows.nth(1)).toHaveCSS('min-height', '28px')
    await expect(rows.nth(1)).toHaveCSS('border-bottom-width', '1px')
    await expect(rows.nth(1).locator('.import-badge')).toHaveCSS('border-radius', '5px')

    const cancel = cancelButton(sheet)
    await expect(cancel).toHaveCSS('border-radius', '5px')
    expect((await box(cancel)).height).toBe(22)

    await expect(sheet.locator('.import-tree-summary')).toBeHidden()
    await expect(sheet.locator('.import-folder-icon').first()).toBeHidden()
    await expect(sheet.locator('.import-mapping-icon')).toBeHidden()
  })

  test('a confirm dialog', async ({ page }) => {
    const dialog = await openConfirm(page, false)
    await expect(dialog).toHaveCSS('border-radius', '8px')
    await expect(dialog).toHaveCSS('padding', '18px')
    expect(await css(dialog, 'backdrop-filter')).toBe('none')
    await expect(cancelButton(dialog)).toHaveCSS('border-radius', '5px')
    await expect(dialog.locator('.confirm-icon')).toBeHidden()
    await expect(dialog.locator('.confirm-actions')).toHaveCSS('flex-direction', 'row')
    await expect(dialog).toHaveCSS('text-align', 'start')
    expect((await box(cancelButton(dialog))).height).toBe(22)
    const first = await box(dialog.locator('.confirm-actions .button').first())
    expect(first.width).toBeLessThan(120)
    const destructive = dialog.getByRole('button', { name: 'Delete Notebook' })
    await expect(destructive).not.toHaveCSS('color', 'rgb(255, 255, 255)')
  })

  test('the link dialog', async ({ page }) => {
    const dialog = await openLinkDialog(page, false)
    await expect(dialog).toHaveCSS('border-radius', '12px')
    await expect(dialog).toHaveCSS('padding', '0px')
    expect(await css(dialog, 'backdrop-filter')).toBe('none')
    await expect(cancelButton(dialog)).toHaveCSS('border-radius', '7px')
  })
})
