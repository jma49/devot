import type { Page } from '@playwright/test'
import { expect, test, openApp } from './fixtures'
import { zhHans } from '../../src/renderer/src/i18n/zh-Hans'

/** size.pane-min-width */
const PANE_MIN = 240

type Box = { x: number; y: number; width: number; height: number }

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const showSidebar = (page: Page) => page.getByRole('button', { name: 'Show Sidebar' })
const mode = (page: Page, name: 'Write Mode' | 'Edit' | 'Split' | 'Preview') =>
  page.getByRole('group', { name: 'View mode' }).getByRole('button', { name })
const format = (page: Page) => page.getByRole('toolbar', { name: 'Format' })

async function box(locator: ReturnType<Page['locator']>): Promise<Box> {
  const b = await locator.boundingBox()
  if (!b) throw new Error('E_TEST_NOT_VISIBLE')
  return b
}

async function openNote(page: Page, width: number, text: string) {
  await page.setViewportSize({ width, height: 700 })
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.insertText(text)
}

for (const width of [760, 800, 900]) {
  test(`showing the sidebar keeps Split and More inside a ${width} px window`, async ({ page }) => {
    await openNote(page, width, 'alpha beta gamma delta')
    await mode(page, 'Split').click()
    await showSidebar(page).click()
    await expect(sidebar(page)).toBeVisible()

    const editor = page.locator('[data-devot-part=editor-body]')
    const preview = page.getByRole('article', { name: 'Preview' })
    const more = page.locator('.editor-toolbar').getByRole('button', { name: 'More', exact: true })
    for (const pane of [editor, preview, more]) {
      await expect
        .poll(async () => {
          const b = await box(pane)
          return b.x >= 0 && b.x + b.width <= width
        })
        .toBe(true)
    }
    expect((await box(editor)).width).toBeGreaterThanOrEqual(PANE_MIN)
    expect((await box(preview)).width).toBeGreaterThanOrEqual(PANE_MIN)
    await more.click()
    await expect(sidebar(page)).toBeHidden()
    await expect(mode(page, 'Split')).toHaveAttribute('aria-pressed', 'true')
  })

  test(`the editor toolbar and the split panes fit a ${width} px window`, async ({ page }) => {
    await openNote(page, width, 'alpha beta gamma delta')
    await mode(page, 'Split').click()

    await expect(sidebar(page)).toBeHidden()
    await expect(showSidebar(page)).toBeVisible()

    const toolbar = page.locator('.editor-toolbar')
    const controls = toolbar.locator('button')
    const count = await controls.count()
    expect(count).toBeGreaterThanOrEqual(7)
    for (let i = 0; i < count; i += 1) {
      const b = await box(controls.nth(i))
      expect(b.x, `control ${i} starts inside`).toBeGreaterThanOrEqual(0)
      expect(b.x + b.width, `control ${i} ends inside`).toBeLessThanOrEqual(width)
      expect(b.width, `control ${i} keeps a width`).toBeGreaterThan(20)
    }
    const clipped = await toolbar.evaluate((el) => el.scrollWidth)
    expect(clipped).toBeLessThanOrEqual((await box(toolbar)).width)
    expect(
      await page.evaluate(() => window.document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width)

    const editor = await box(page.locator('[data-devot-part=editor-body]'))
    const preview = await box(page.getByRole('article', { name: 'Preview' }))
    expect(editor.width).toBeGreaterThanOrEqual(PANE_MIN)
    expect(preview.width).toBeGreaterThanOrEqual(PANE_MIN)
    expect(preview.x + preview.width).toBeLessThanOrEqual(width)
    expect(preview.x).toBeGreaterThanOrEqual(editor.x + editor.width - 1)
  })

  test(`the selection toolbar shows every button inside the pane in split mode (${width} px)`, async ({
    page,
  }) => {
    await openNote(page, width, 'alpha beta gamma delta')
    await mode(page, 'Split').click()
    await page.getByRole('textbox', { name: 'Note body' }).click()
    await page.keyboard.press('ControlOrMeta+a')
    await expect(format(page)).toBeVisible()

    const buttons = format(page).getByRole('button')
    const count = await buttons.count()
    expect(count).toBe(14)
    const editor = await box(page.locator('[data-devot-part=editor-body]'))
    // CodeMirror places it in the next frames: wait until it is inside the pane.
    await expect
      .poll(async () => {
        const b = await box(format(page))
        return b.x >= editor.x - 1 && b.x + b.width <= editor.x + editor.width + 1
      })
      .toBe(true)
    // The bar wraps between its groups instead of scrolling, so every button is whole inside the pane.
    for (let i = 0; i < count; i += 1) {
      const b = await box(buttons.nth(i))
      expect(b.x, `button ${i} inside the pane`).toBeGreaterThanOrEqual(editor.x - 1)
      expect(b.x + b.width, `button ${i} inside the pane`).toBeLessThanOrEqual(
        editor.x + editor.width + 1,
      )
    }
    await format(page).getByRole('button', { name: 'Quote' }).click()
    await expect(page.locator('.cm-line')).toHaveText('> alpha beta gamma delta')
  })
}

test.describe('Simplified Chinese', () => {
  test.use({ locale: 'zh-Hans' })

  test('the minimum-width sidebar shows the whole backup and mirror status in Split', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 760, height: 700 })
    await page.addInitScript(() => {
      window.devotIpcMocks = { backups_list: { backups: [], lastError: null } }
    })
    await openApp(page)
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans')
    await page.getByRole('button', { name: zhHans['noteList.newNote'], exact: true }).click()
    await expect(page.getByRole('textbox', { name: zhHans['note.titleLabel'] })).toHaveValue('')
    await page.getByRole('textbox', { name: zhHans['note.bodyLabel'] }).click()
    await page.keyboard.insertText('Split note')
    await page.getByRole('button', { name: zhHans['mode.split'], exact: true }).click()

    const editor = page.locator('[data-devot-part=editor-body]')
    const preview = page.getByRole('article', { name: zhHans['preview.label'] })
    await expect(preview).toHaveText('Split note')
    const split = await Promise.all([box(editor), box(preview)])
    await page.getByRole('button', { name: zhHans['command.showSidebar'] }).click()
    const overlay = page.getByRole('navigation', { name: zhHans['sidebar.label'] })
    await overlay.getByRole('separator', { name: zhHans['sidebar.resize'] }).press('Home')
    await expect.poll(async () => (await box(overlay)).width).toBe(170)

    const status = overlay.locator('.footer-saved')
    await expect(status).toHaveText(zhHans['sidebar.notBackedUp'])
    await expect.poll(() => status.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    expect(await Promise.all([box(editor), box(preview)])).toEqual(split)
  })
})

test('the sidebar shows at 1000 px, gives way below it, and comes back on request', async ({
  page,
}) => {
  await openNote(page, 1000, 'note')
  await expect(sidebar(page)).toBeVisible()
  await expect(showSidebar(page)).toBeHidden()

  await page.setViewportSize({ width: 999, height: 700 })
  await expect(sidebar(page)).toBeHidden()
  await expect(showSidebar(page)).toBeVisible()

  await showSidebar(page).click()
  await expect(sidebar(page)).toBeVisible()
  await page.getByRole('button', { name: 'Hide Sidebar' }).click()
  await expect(sidebar(page)).toBeHidden()

  // A wide window shows it again: the narrow window's choice was not saved.
  await page.setViewportSize({ width: 1280, height: 700 })
  await expect(sidebar(page)).toBeVisible()
  await page.reload()
  await expect(sidebar(page)).toBeVisible()
})

test('a sidebar asked for in a narrow window is hidden again after a trip through a wide one', async ({
  page,
}) => {
  await openNote(page, 800, 'note')
  await showSidebar(page).click()
  await expect(sidebar(page)).toBeVisible()
  await page.setViewportSize({ width: 1280, height: 700 })
  await expect(sidebar(page)).toBeVisible()
  // The window has rendered as a wide one before it narrows again.
  await expect(page.locator('.window')).not.toHaveAttribute('data-narrow')
  await page.setViewportSize({ width: 800, height: 700 })
  await expect(sidebar(page)).toBeHidden()
  await expect(showSidebar(page)).toBeVisible()
})

test('the window follows its width when the media query reports no change', async ({ page }) => {
  await page.addInitScript(() => {
    const proto = window.MediaQueryList.prototype
    proto.addEventListener = () => {}
  })
  await openNote(page, 800, 'note')
  await expect(page.locator('.window')).toHaveAttribute('data-narrow')
  await page.setViewportSize({ width: 1280, height: 700 })
  await expect(page.locator('.window')).not.toHaveAttribute('data-narrow')
  await page.setViewportSize({ width: 800, height: 700 })
  await expect(page.locator('.window')).toHaveAttribute('data-narrow')
})

test('a sidebar the user hid stays hidden in a wide window', async ({ page }) => {
  await openNote(page, 1280, 'note')
  await page.getByRole('button', { name: 'Hide Sidebar' }).click()
  await expect(sidebar(page)).toBeHidden()
  await page.setViewportSize({ width: 800, height: 700 })
  await page.setViewportSize({ width: 1280, height: 700 })
  await expect(sidebar(page)).toBeHidden()
  await expect(showSidebar(page)).toBeVisible()
})

test('Cmd+/ shows the sidebar in a narrow window, which then fits without scrolling sideways', async ({
  page,
}) => {
  await openNote(page, 800, 'note')
  await expect(sidebar(page)).toBeHidden()
  await page.keyboard.press('Meta+Slash')
  await expect(sidebar(page)).toBeVisible()
  await expect(page.getByRole('region', { name: 'Notes' })).toBeVisible()
  expect(
    await page.evaluate(() => window.document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(800)
  await page.keyboard.press('Meta+Slash')
  await expect(sidebar(page)).toBeHidden()
})

test('opening the narrow sidebar moves an already focused list row into the sidebar', async ({
  page,
}) => {
  await openNote(page, 800, 'note')
  const row = page.getByRole('listbox', { name: 'Notes' }).getByRole('option').first()
  await row.focus()
  await expect(row).toBeFocused()
  await page.keyboard.press('Meta+Slash')
  await expect(sidebar(page)).toBeVisible()
  await expect(sidebar(page).locator('[data-sidebar-row][tabindex="0"]')).toBeFocused()
  await page.keyboard.press('Meta+Slash')
  await expect(sidebar(page)).toBeHidden()
  await expect(row).toBeFocused()
})

test('keyboard focus dismisses the narrow sidebar before it can cover a list control', async ({
  page,
}) => {
  await openNote(page, 800, 'note')
  await showSidebar(page).click()
  await expect(sidebar(page)).toBeVisible()
  const newNote = page.getByRole('button', { name: 'New Note', exact: true })
  await newNote.focus()
  await expect(sidebar(page)).toBeHidden()
  await expect(newNote).toBeFocused()
})

test('showing the sidebar in a narrow window keeps a sidebar hidden in a wide one hidden', async ({
  page,
}) => {
  await openNote(page, 1200, 'note')
  await page.getByRole('button', { name: 'Hide Sidebar' }).click()
  await expect(sidebar(page)).toBeHidden()
  await page.setViewportSize({ width: 900, height: 700 })
  await expect(page.locator('.window')).toHaveAttribute('data-narrow')
  await page.keyboard.press('Meta+Slash')
  await expect(sidebar(page)).toBeVisible()
  await page.keyboard.press('Meta+Slash')
  await expect(sidebar(page)).toBeHidden()
  await page.keyboard.press('Meta+Slash')
  await expect(sidebar(page)).toBeVisible()

  await page.setViewportSize({ width: 1200, height: 700 })
  await expect(page.locator('.window')).not.toHaveAttribute('data-narrow')
  await expect(sidebar(page)).toBeHidden()
  expect(await page.evaluate(() => localStorage.getItem('devot.sidebarHidden.main'))).toBe('1')
})
