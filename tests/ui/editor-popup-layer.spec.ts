import type { Locator, Page } from '@playwright/test'
import { expect, openApp, test } from './fixtures'

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const formatBar = (page: Page) =>
  page.locator('.cm-tooltip', { has: page.getByRole('toolbar', { name: 'Format' }) })
const slashMenu = (page: Page) => page.locator('.cm-tooltip-autocomplete')

async function newNote(page: Page, text: string) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await expect(body(page)).toHaveText('')
  await body(page).click()
  await page.keyboard.insertText(text)
}

/** Every ancestor of a popup up to the root, across the editor's shadow boundary, that masks or clips what it paints. */
const maskingAncestors = (popup: Locator) =>
  popup.evaluate((el) => {
    const found: string[] = []
    const box = el.getBoundingClientRect()
    let at: Element | null = el
    while (at) {
      at = at.parentElement ?? (at.getRootNode() as ShadowRoot).host ?? null
      if (!at) break
      const style = getComputedStyle(at)
      const mask = style.maskImage || style.getPropertyValue('-webkit-mask-image') || 'none'
      const clips =
        style.clipPath !== 'none' ||
        ['overflowX', 'overflowY'].some(
          (axis) => style[axis as 'overflowX' | 'overflowY'] !== 'visible',
        )
      const r = at.getBoundingClientRect()
      const holds =
        r.top <= box.top && r.left <= box.left && r.bottom >= box.bottom && r.right >= box.right
      if (mask !== 'none' || (clips && !holds)) found.push(at.className || at.tagName)
    }
    return found
  })

test.beforeEach(async ({ page }) => {
  await openApp(page)
})

test('the format bar over the first line is drawn whole above the panes, over the meta row', async ({
  page,
}) => {
  await newNote(page, 'first line\nsecond line')
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('Shift+ControlOrMeta+ArrowRight')
  await expect(formatBar(page)).toBeVisible()
  await page.evaluate(() => new Promise((done) => window.requestAnimationFrame(() => done(null))))
  const bar = (await formatBar(page).boundingBox())!
  const panes = (await page.locator('.panes').boundingBox())!
  expect(bar.y).toBeLessThan(panes.y)
  expect(await maskingAncestors(formatBar(page))).toEqual([])
  const onTop = await formatBar(page).evaluate(
    (el, [x, y]) => {
      const hit = document.elementFromPoint(x, y)
      const inner = hit?.shadowRoot?.elementFromPoint(x, y) ?? hit
      return !!inner && el.contains(inner)
    },
    [bar.x + bar.width / 2, bar.y + 2] as const,
  )
  expect(onTop).toBe(true)
})

test('the slash menu keeps its blur, with no masked ancestor, while the note is scrolled', async ({
  page,
}) => {
  await newNote(page, Array.from({ length: 80 }, (_, i) => `Paragraph ${i}`).join('\n\n') + '\n\n')
  await expect(page.locator('.content')).toHaveAttribute('data-scrolled')
  await expect(page.locator('.editor-scroll')).not.toHaveCSS('mask-image', 'none')
  await page.keyboard.type('/')
  await expect(slashMenu(page)).toBeVisible()
  expect(await slashMenu(page).evaluate((el) => getComputedStyle(el).backdropFilter)).toContain(
    'blur(',
  )
  expect(await maskingAncestors(slashMenu(page))).toEqual([])
})
