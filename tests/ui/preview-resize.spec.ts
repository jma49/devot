import type { Page } from '@playwright/test'
import { expectWithinBudget, setOverloadProbe } from '../support/budget'
import { machineOverloaded } from '../support/machine-load'
import { expect, openApp, test } from './fixtures'
import type { ViewLike } from './keystrokes'
import { longNote } from './longNote'

// Resizing the window in Preview on a 600 KB note held one frame for about 2.9 s (#786): the sheet's
// cutout around the sidebar (sidebarSurround.ts) holds the window's size, and written on the root it
// was inherited by every element, so WebKit compared each one's 700-odd custom properties again.
// The structural test holds what each block inherits across a resize on every platform; the frame
// budget stretches on CI and an overloaded local machine skips (tests/support/budget.ts).
const RESIZE_BUDGET_MS = 1500
const NOTE_CHARS = 600_000
const NARROWER_PX = 240
const WATCH_MS = 2000

setOverloadProbe(machineOverloaded)

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const preview = (page: Page) => page.getByRole('article', { name: 'Preview' })
const modeButton = (page: Page, name: string) =>
  page.getByRole('group', { name: 'View mode' }).getByRole('button', { name, exact: true })

async function openInPreview(page: Page, text: string) {
  const last = text
    .match(/^## Section \d+$/gm)!
    .at(-1)!
    .slice(3)
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await body(page).click()
  await page.keyboard.insertText('x')
  await body(page).evaluate((el, insert) => {
    const view = (el as unknown as { cmTile: { view: ViewLike } }).cmTile.view
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert } })
  }, text)
  await modeButton(page, 'Preview').click()
  await expect(preview(page).getByRole('heading', { name: last, exact: true })).toBeAttached({
    timeout: 60_000,
  })
  await page.waitForTimeout(1500)
}

async function narrower(page: Page) {
  const { width, height } = page.viewportSize()!
  await page.setViewportSize({ width: width - NARROWER_PX, height })
}

/** The custom properties a block of the preview computes, by name. */
const inherited = (page: Page) =>
  preview(page)
    .locator('p')
    .first()
    .evaluate((el) => {
      const style = getComputedStyle(el)
      const custom: Record<string, string> = {}
      for (const name of Array.from(style)) {
        if (name.startsWith('--')) custom[name] = style.getPropertyValue(name)
      }
      return custom
    })

test('resizing the window in Preview changes nothing the blocks inherit', async ({ page }) => {
  await openInPreview(page, longNote(20_000))
  const before = await inherited(page)
  expect(Object.keys(before).length).toBeGreaterThan(100)
  const sheet = () =>
    page.locator('.window').evaluate((el) => getComputedStyle(el, '::before').clipPath)
  const cutout = await sheet()
  expect(cutout).toMatch(/^path\(/)

  await narrower(page)
  await expect.poll(sheet).not.toBe(cutout)
  expect(await inherited(page)).toEqual(before)
})

test('resizing the window in Preview on a 600 KB note never holds a frame long', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await openInPreview(page, longNote(NOTE_CHARS))

  await page.evaluate((ms) => {
    const run = { times: [] as number[], done: false }
    window.devotFrameTimes = run
    const start = performance.now()
    const frame = () => {
      const now = performance.now()
      run.times.push(now)
      if (now - start < ms) requestAnimationFrame(frame)
      else run.done = true
    }
    requestAnimationFrame(frame)
  }, WATCH_MS)
  await narrower(page)
  await page.waitForFunction(() => window.devotFrameTimes.done, null, {
    timeout: 120_000,
  })
  const longest = await page.evaluate(() => {
    const { times } = window.devotFrameTimes
    let most = 0
    for (let i = 1; i < times.length; i++) most = Math.max(most, times[i]! - times[i - 1]!)
    return most
  })

  expectWithinBudget({ skip: (why) => test.skip(true, why) }, longest, RESIZE_BUDGET_MS)
})
