import { expect, openApp, test } from './fixtures'

test('a sidebar button shows the bubble above it, with no system tooltip', async ({ page }) => {
  await openApp(page)
  const button = page.getByRole('button', { name: 'New Notebook' })
  await button.hover()
  const tip = page.getByRole('tooltip')
  await expect(tip).toBeVisible()
  await expect(tip).toContainText('New Notebook')
  // The system tooltip reads `title`: it waits in `data-tip` while the bubble shows.
  await expect(button).not.toHaveAttribute('title', /.+/)
  const [b, t] = await Promise.all([button.boundingBox(), tip.boundingBox()])
  if (!b || !t) throw new Error('missing boxes')
  expect(t.y + t.height).toBeLessThanOrEqual(b.y - 11)
  await expect(tip).toHaveAttribute('data-side', 'above')
  await page.mouse.move(400, 400)
  await expect(tip).toBeHidden()
  await expect(button).toHaveAttribute('title', /.+/)
})

test('a toolbar button at the window edge keeps its bubble inside the window', async ({ page }) => {
  await openApp(page)
  const buttons = page.getByRole('toolbar', { name: 'Toolbar' }).getByRole('button')
  await buttons.last().hover()
  const tip = page.getByRole('tooltip')
  await expect(tip).toBeVisible()
  const box = await tip.boundingBox()
  const size = page.viewportSize()
  if (!box || !size) throw new Error('missing boxes')
  expect(box.x).toBeGreaterThanOrEqual(8)
  expect(box.x + box.width).toBeLessThanOrEqual(size.width - 8)
})

test('a press hides the bubble', async ({ page }) => {
  await openApp(page)
  const button = page.getByRole('button', { name: 'New Notebook' })
  await button.hover()
  await expect(page.getByRole('tooltip')).toBeVisible()
  await page.mouse.down()
  await expect(page.getByRole('tooltip')).toBeHidden()
  await page.mouse.up()
})

test('keyboard focus shows the bubble too, and leaving the button hides it', async ({ page }) => {
  await openApp(page)
  const button = page.getByRole('button', { name: 'New Notebook' })
  // Focus after a key press (not a click) is what makes the focus ring show.
  await page.keyboard.press('Tab')
  await button.evaluate((el) => el.focus())
  const tip = page.getByRole('tooltip')
  await expect(tip).toBeVisible()
  await expect(tip).toContainText('New Notebook')
  await button.evaluate((el) => el.blur())
  await expect(tip).toBeHidden()
})
