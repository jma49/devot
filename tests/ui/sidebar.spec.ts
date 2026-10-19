import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const header = (page: Page) => page.getByRole('toolbar', { name: 'Toolbar' }).locator('.headline')
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

async function createTag(page: Page, name: string) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(1)
  await page.getByRole('textbox', { name: 'Title' }).fill('Tagged')
  const field = page.getByRole('combobox', { name: 'Add Tag' })
  await field.fill(name)
  await field.press('Enter')
  await expect(
    sidebar(page).getByRole('button', { name: new RegExp(`^${name} \\d+$`) }),
  ).toBeVisible()
}

test('lists the sections in order: All Notes, Pinned, Templates, Notebooks, Status, Tags, Trash', async ({
  page,
}) => {
  await createTag(page, 'urgent')
  const order = await sidebar(page).evaluate((nav) =>
    Array.from(nav.querySelectorAll('.source-label, .section-header > span:first-child')).map(
      (el) => el.textContent,
    ),
  )
  const sections = ['All Notes', 'Pinned', 'Templates', 'Notebooks', 'Status']
  expect(order.slice(0, sections.length)).toEqual(sections)
  expect(order.indexOf('Tags')).toBeGreaterThan(order.indexOf('Dropped'))
  expect(order.at(-1)).toBe('Trash')
})

test('the chevron folds Tags, points up while folded, and the choice is kept after a reload', async ({
  page,
}) => {
  await createTag(page, 'urgent')
  const row = sidebar(page).getByRole('button', { name: /^urgent \d+$/ })
  await sidebar(page).getByRole('button', { name: 'Collapse Tags' }).click()
  await expect(row).toHaveCount(0)
  await expect(sidebar(page).getByRole('button', { name: 'Expand Tags' })).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  await page.reload()
  await expect(sidebar(page).getByRole('button', { name: 'Expand Tags' })).toBeVisible()
  await expect(row).toHaveCount(0)
  await sidebar(page).getByRole('button', { name: 'Expand Tags' }).click()
  await expect(row).toBeVisible()
})

test.describe('two folds in quick succession', () => {
  test.use({ reducedMotion: 'no-preference' })

  test('both stay folded and both are kept after a reload', async ({ page }) => {
    await createTag(page, 'urgent')
    // Both clicks land inside the shrink animation of the first.
    await sidebar(page).evaluate((nav) => {
      for (const name of ['Collapse Status', 'Collapse Tags']) {
        nav.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)?.click()
      }
    })
    await expect(sidebar(page).getByRole('button', { name: 'Expand Status' })).toBeVisible()
    await expect(sidebar(page).getByRole('button', { name: 'Expand Tags' })).toBeVisible()
    await page.reload()
    await expect(sidebar(page).getByRole('button', { name: 'Expand Status' })).toBeVisible()
    await expect(sidebar(page).getByRole('button', { name: 'Expand Tags' })).toBeVisible()
  })
})

test('the Tags chevron turns up over the toggle duration and back down, and Reduce Motion turns it at once', async ({
  page,
}) => {
  // The UI tests run with Reduce Motion on (playwright.config.ts).
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await createTag(page, 'urgent')
  const chevron = sidebar(page).locator('.section-header', { hasText: 'Tags' }).locator('.chevron')
  const style = (property: string) =>
    chevron.evaluate(
      (el, p) =>
        (
          globalThis as unknown as {
            getComputedStyle(e: unknown): {
              getPropertyValue(n: string): string
            }
          }
        )
          .getComputedStyle(el)
          .getPropertyValue(p),
      property,
    )
  expect(await style('transition-duration')).toBe('0.2s')
  await sidebar(page).getByRole('button', { name: 'Collapse Tags' }).click()
  await expect(chevron).toHaveAttribute('data-turn', 'up')
  await expect.poll(() => style('rotate')).toBe('180deg')
  await sidebar(page).getByRole('button', { name: 'Expand Tags' }).click()
  await expect(chevron).not.toHaveAttribute('data-turn')
  await expect(sidebar(page).locator('#tags-list')).toBeVisible()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(() => style('transition-duration')).toBe('0s')
})

test('the search buttons open the palette scoped to notebooks and to tags', async ({ page }) => {
  await createTag(page, 'urgent')
  const palette = page.getByRole('dialog', { name: 'Command Palette' })
  await sidebar(page).getByRole('button', { name: 'Search Notebooks' }).click()
  await expect(palette.getByRole('combobox')).toHaveAttribute('placeholder', 'Search notebooks...')
  await palette.getByRole('combobox').press('Escape')
  await palette.getByRole('combobox').press('Escape')
  await expect(palette).toHaveCount(0)
  await sidebar(page).getByRole('button', { name: 'Search Tags' }).click()
  await expect(palette.getByRole('combobox')).toHaveAttribute('placeholder', 'Search tags...')
  await expect(palette.locator('#palette-keys')).toContainText('Show Notes with Tag')
})

test('Shift+Cmd+J moves the selection from All Notes to the next row', async ({ page }) => {
  await sidebar(page)
    .getByRole('button', { name: /^All Notes/ })
    .click()
  await expect(header(page)).toHaveText('All Notes')
  await page.keyboard.press('Meta+Shift+KeyJ')
  await expect(sidebar(page).getByRole('button', { name: /^Pinned/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
})

test('the footer shows when the last note was saved', async ({ page }) => {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await page.getByRole('textbox', { name: 'Title' }).fill('Saved')
  await expect(sidebar(page)).toContainText(/Saved at \d\d:\d\d:\d\d/)
  await sidebar(page).getByRole('button', { name: 'Backup and mirror status' }).click()
  await expect(sidebar(page).getByRole('group', { name: 'Backup and mirror status' })).toBeVisible()
})

test('the sidebar scrolls when its notebooks and tags overflow, and focus reveals an off-screen row', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 500 })
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(1)
  const field = page.getByRole('combobox', { name: 'Add Tag' })
  for (let i = 0; i < 30; i++) {
    await field.fill(`tag${String(i).padStart(2, '0')}`)
    await field.press('Enter')
  }
  const area = sidebar(page).locator('.sidebar-scroll')
  await expect(sidebar(page).getByRole('button', { name: /^tag29 \d+$/ })).toBeAttached()
  const { scrollHeight, clientHeight } = await area.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }))
  expect(scrollHeight).toBeGreaterThan(clientHeight)
  // The sidebar itself does not grow past the window, so Trash stays reachable.
  const [navScroll, navClient] = await sidebar(page).evaluate((el) => [
    el.scrollHeight,
    el.clientHeight,
  ])
  expect(navScroll).toBe(navClient)
  await expect(sidebar(page).getByRole('button', { name: /^Trash \d+$/ })).toBeInViewport()
  // Focusing the last tag scrolls it into view.
  const last = sidebar(page).getByRole('button', { name: /^tag29 \d+$/ })
  await last.focus()
  await expect(last).toBeInViewport()
  expect(await area.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
})
