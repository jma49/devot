import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

async function freshStart(page: Page) {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
}

const focusButton = (page: Page) => page.getByRole('button', { name: 'Focus Mode' })

test('the toolbar button enters and leaves focus mode', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await freshStart(page)
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' })
  const list = page.getByRole('region', { name: 'Notes' })
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await page.getByRole('textbox', { name: 'Title' }).fill('Quiet')

  await expect(focusButton(page)).toHaveAttribute('aria-pressed', 'false')
  await focusButton(page).click()
  await expect(focusButton(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(sidebar).toBeHidden()
  await expect(list).toBeHidden()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Quiet')

  const main = await page.getByRole('main').boundingBox()
  const body = await page.locator('.panes').boundingBox()
  expect(main?.width).toBe(1600)
  expect(body?.width).toBeLessThanOrEqual(740)
  expect(Math.abs((body?.x ?? 0) * 2 + (body?.width ?? 0) - 1600)).toBeLessThanOrEqual(1)

  await focusButton(page).click()
  await expect(focusButton(page)).toHaveAttribute('aria-pressed', 'false')
  await expect(sidebar).toBeVisible()
  await expect(list).toBeVisible()
})

test('in focus mode with Split, the title and metadata line up with the two panes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await freshStart(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await page.getByRole('textbox', { name: 'Title' }).fill('Wide')
  await focusButton(page).click()
  await page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Split' })
    .click()
  const panes = page.locator('.content > .panes-split')
  await expect(panes).toBeVisible()
  const split = (await panes.boundingBox())!
  // The header follows the two panes' width, not the single reading column (A155).
  for (const part of ['.content > .title', '.content > .note-meta']) {
    const box = (await page.locator(part).boundingBox())!
    expect(Math.abs(box.x - split.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(box.width - split.width)).toBeLessThanOrEqual(1)
  }
})

test('Shift+Cmd+D toggles focus mode, and the window remembers it', async ({ page }) => {
  await freshStart(page)
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' })
  await expect(focusButton(page)).toHaveAttribute('title', 'Focus Mode (\u21e7\u2318D)')
  await page.keyboard.press('Meta+Shift+KeyD')
  await expect(sidebar).toBeHidden()
  await expect(page.getByRole('region', { name: 'Notes' })).toBeHidden()

  await page.reload()
  await expect(focusButton(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(sidebar).toBeHidden()

  await page.keyboard.press('Meta+Shift+KeyD')
  await expect(sidebar).toBeVisible()
  await page.reload()
  await expect(focusButton(page)).toHaveAttribute('aria-pressed', 'false')
  await expect(sidebar).toBeVisible()
})

test('both search shortcuts leave focus mode and focus the field', async ({ page }) => {
  await freshStart(page)
  for (const keys of ['Meta+Alt+Shift+KeyF', 'Meta+Shift+KeyF']) {
    await focusButton(page).click()
    await expect(page.getByRole('searchbox', { name: 'Search notes' })).toBeHidden()
    await page.keyboard.press(keys)
    await expect(focusButton(page)).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible()
    await expect(page.getByRole('searchbox', { name: 'Search notes' })).toBeFocused()
  }
})

test('hiding the panes fades them and slides the editor, and Reduce Motion makes it immediate', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await freshStart(page)
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' })
  // By class: a hidden pane has no role to find it by.
  const moves = (pane: string) =>
    page.locator(`.window > .${pane}`).evaluate((el) =>
      el
        .getAnimations()
        .filter((a) => !('animationName' in a) && !('transitionProperty' in a))
        .map((a) => JSON.stringify((a.effect as KeyframeEffect).getKeyframes()[0])),
    )
  const widthOf = () =>
    page.locator('.window > .sidebar').evaluate((el) => el.getBoundingClientRect().width)
  const full = await widthOf()

  await page.keyboard.press('Meta+Shift+KeyD')
  await expect.poll(() => moves('content')).toEqual([expect.stringContaining('translateX(')])
  expect(await moves('sidebar')).toEqual([expect.stringContaining('"opacity":"1"')])
  await expect(sidebar).toBeHidden()
  expect(await widthOf()).toBe(full)
  await page.keyboard.press('Meta+Shift+KeyD')
  await expect(sidebar).toBeVisible()

  await page.emulateMedia({ reducedMotion: 'reduce' })
  // The window follows the system (fixtures.ts) once it hears of the change.
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced')
  await page.keyboard.press('Meta+Shift+KeyD')
  await expect(page.locator('.window')).toHaveAttribute('data-focus', 'true')
  expect(await moves('content')).toEqual([])
  await expect(sidebar).toBeHidden({ timeout: 100 })
})
