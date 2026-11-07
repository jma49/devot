import type { Locator, Page } from '@playwright/test'
import { changeEditorSettingsElsewhere, expect, openApp, test } from './fixtures'

test.use({ viewport: { width: 1280, height: 820 } })

async function rect(locator: Locator) {
  const found = await locator.boundingBox()
  if (!found) throw new Error('no box')
  return { top: found.y, bottom: found.y + found.height }
}

async function note(page: Page, title: string, text: string) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.insertText(text)
}

const row = (page: Page, title: string) =>
  page.locator('.row').filter({ has: page.locator('.row-title', { hasText: title }) })

const baseline = (locator: Locator): Promise<number> =>
  locator.evaluate((el) => {
    const probe = document.createElement('span')
    probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline'
    el.append(probe)
    const y = probe.getBoundingClientRect().bottom
    probe.remove()
    return y
  })

test.beforeEach(async ({ page }) => {
  await openApp(page)
})

test('a row spaces title, meta and excerpt evenly and shares one baseline', async ({ page }) => {
  await note(page, 'Tasks', '- [x] done\n- [ ] open\n\nSome words after the tasks.')
  const withMeta = row(page, 'Tasks')
  await expect(withMeta.locator('.row-progress')).toBeVisible()
  const whole = await rect(withMeta)
  const title = await rect(withMeta.locator('.row-title'))
  const meta = await rect(withMeta.locator('.row-meta'))
  const excerpt = await rect(withMeta.locator('.row-excerpt'))
  expect(Math.abs(meta.top - title.bottom - 4)).toBeLessThanOrEqual(1)
  expect(Math.abs(excerpt.top - meta.bottom - 4)).toBeLessThanOrEqual(1)
  expect(Math.round(title.top - whole.top)).toBe(10)
  expect(Math.round(whole.bottom - excerpt.bottom)).toBe(11)

  const time = withMeta.locator('.row-time')
  expect(
    Math.abs((await baseline(withMeta.locator('.row-title'))) - (await baseline(time))),
  ).toBeLessThanOrEqual(1)
  await expect(time).toHaveCSS('font-size', '11px')
  await expect(withMeta.locator('.row-title')).toHaveCSS('font-size', '13px')
  await expect(withMeta.locator('.row-title')).toHaveCSS('font-weight', '600')
  await expect(withMeta.locator('.row-excerpt')).toHaveCSS('font-size', '12px')
  await expect(withMeta.locator('.row-meta-items')).toHaveCSS('column-gap', '6px')
  await expect(withMeta.locator('.row-meta')).toHaveCSS('font-size', '11px')
  await expect(withMeta).toHaveCSS('border-bottom-width', '0px')
})

test('a row without meta leaves no hole, and rows sit 2 pt apart', async ({ page }) => {
  await changeEditorSettingsElsewhere(page, { activityStrip: false })
  await note(page, 'Plain', 'Only words here.')
  await note(page, 'Other', 'More words here.')
  const plain = row(page, 'Plain')
  await expect(plain.locator('.row-excerpt')).toBeVisible()
  const title = await rect(plain.locator('.row-title'))
  const excerpt = await rect(plain.locator('.row-excerpt'))
  expect(Math.abs(excerpt.top - title.bottom - 4)).toBeLessThanOrEqual(1)
  await expect(plain.locator('.row-time')).toBeVisible()
  const upper = await rect(page.locator('.row').first())
  const lower = await rect(page.locator('.row').nth(1))
  expect(Math.round(lower.top - upper.bottom)).toBe(2)
})
