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

/**
 * Every ancestor of a popup up to the root, across the editor's shadow boundary, that masks or clips
 * what it paints. A popup is placed on CodeMirror's next measure, and until then it can lie past
 * the panes or the window, which clip it: a check polls this instead of reading it once.
 */
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
  await expect.poll(() => maskingAncestors(formatBar(page))).toEqual([])
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

test('in Split the format bar has no masked ancestor and the panes stay unmasked', async ({
  page,
}) => {
  await newNote(page, Array.from({ length: 80 }, (_, i) => `Paragraph ${i}`).join('\n\n'))
  await page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Split', exact: true })
    .click()
  await body(page).click()
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('Shift+ControlOrMeta+ArrowRight')
  await expect(formatBar(page)).toBeVisible()
  await expect.poll(() => maskingAncestors(formatBar(page))).toEqual([])
  await expect(page.locator('.panes')).toHaveCSS('mask-image', 'none')
  await expect(page.locator('.editor')).toHaveCSS('mask-image', 'none')
})

test('the link tooltip has no masked ancestor', async ({ page }) => {
  await newNote(page, 'See [docs](https://example.com/a) and more')
  await page.keyboard.press('ControlOrMeta+Home')
  for (let n = 0; n < 6; n++) await page.keyboard.press('ArrowRight')
  const tip = page.locator('.cm-link-tip')
  await expect(tip.getByRole('button', { name: 'Open URL' })).toBeVisible()
  await expect.poll(() => maskingAncestors(tip)).toEqual([])
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
  await expect.poll(() => maskingAncestors(slashMenu(page))).toEqual([])
})
