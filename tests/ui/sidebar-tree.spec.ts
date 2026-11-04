import type { Locator, Page } from '@playwright/test'
import { changeEditorSettingsElsewhere, expect, openApp, pickMenuItem, test } from './fixtures'

test.use({ viewport: { width: 1280, height: 480 } })

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const scroller = (page: Page) => sidebar(page).locator('.sidebar-scroll')
const book = (page: Page, name: string) =>
  page.getByRole('tree', { name: 'Notebooks' }).getByRole('treeitem', {
    name: new RegExp(`^${name}\\b`),
  })
const row = (page: Page, name: string) => book(page, name).locator('> .book-row')
const nameField = (page: Page) => page.getByRole('textbox', { name: 'Notebook name' })
const source = (page: Page, name: string) =>
  sidebar(page).getByRole('button', { name: new RegExp(`^${name}\\b`) })

async function name(page: Page, value: string) {
  await expect(nameField(page)).toBeFocused()
  await nameField(page).fill(value)
  await nameField(page).press('Enter')
  await expect(book(page, value)).toBeVisible()
}

async function createBook(page: Page, value: string) {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  await name(page, value)
}

async function createInside(page: Page, parent: string, value: string) {
  await row(page, parent).click({ button: 'right' })
  await pickMenuItem(page, 'New Notebook Inside')
  await name(page, value)
}

/** Work > Plans > Deep, then enough top-level notebooks to overflow a 480 px window. */
async function setUp(page: Page) {
  await openApp(page)
  await createBook(page, 'Work')
  await createInside(page, 'Work', 'Plans')
  await createInside(page, 'Plans', 'Deep')
  for (const value of ['Home', 'Garden', 'Travel', 'Music']) await createBook(page, value)
}

async function box(target: Locator) {
  const found = await target.boundingBox()
  if (!found) throw new Error('E_TEST_NO_BOX')
  return found
}

const hairlineOpacity = (page: Page) =>
  sidebar(page)
    .locator('> .sources')
    .first()
    .evaluate((el) => getComputedStyle(el, '::after').opacity)

test('the list fades only at an edge with more beyond it, and a hairline shows once scrolled', async ({
  page,
}) => {
  await setUp(page)
  const list = scroller(page)
  await list.evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(list).not.toHaveAttribute('data-scrolled')
  await expect(list).toHaveAttribute('data-more-below')
  await expect(list).toHaveCSS('--scroll-edge-size', '0px')
  await expect(list).toHaveCSS('--scroll-edge-bottom-size', '18px')
  await expect.poll(() => hairlineOpacity(page)).toBe('0')

  await list.evaluate((el) => {
    el.scrollTop = 40
  })
  await expect(list).toHaveAttribute('data-scrolled')
  await expect(list).toHaveCSS('--scroll-edge-size', '18px')
  await expect(list).not.toHaveCSS('mask-image', 'none')
  await expect.poll(() => hairlineOpacity(page)).toBe('1')

  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await expect(list).not.toHaveAttribute('data-more-below')
  await expect(list).toHaveCSS('--scroll-edge-bottom-size', '0px')
})

test('the fade follows the content when a window grows or a section folds', async ({ page }) => {
  await setUp(page)
  const list = scroller(page)
  await expect(list).toHaveAttribute('data-more-below')
  await page.setViewportSize({ width: 1280, height: 1400 })
  await expect(list).not.toHaveAttribute('data-more-below')
  await page.setViewportSize({ width: 1280, height: 480 })
  await expect(list).toHaveAttribute('data-more-below')
  await page.getByRole('button', { name: 'Collapse Notebooks' }).click()
  await page.getByRole('button', { name: 'Collapse Status' }).click()
  await expect(list).not.toHaveAttribute('data-more-below')
  await page.getByRole('button', { name: 'Expand Notebooks' }).click()
  await expect(list).toHaveAttribute('data-more-below')
})

test('every row shares one inset, radius and left edge, whatever its depth', async ({ page }) => {
  await setUp(page)
  await row(page, 'Deep').click()
  await expect(book(page, 'Deep')).toHaveAttribute('aria-selected', 'true')
  const side = await box(sidebar(page))
  const rows = [
    source(page, 'All Notes'),
    source(page, 'Trash'),
    source(page, 'Active'),
    row(page, 'Work'),
    row(page, 'Plans'),
    row(page, 'Deep'),
  ]
  for (const target of rows) {
    const edges = await box(target)
    expect(edges.x - side.x).toBe(8)
    expect(side.x + side.width - (edges.x + edges.width)).toBe(8)
    await expect(target).toHaveCSS('border-radius', '10px')
  }
})

test('depth steps 16 px, keeps each chevron inside its row, and guides down the children', async ({
  page,
}) => {
  await setUp(page)
  const icon = (value: string) =>
    row(page, value).locator(':is(.icon, .icon-svg):not(.disclosure *)')
  const [work, plans, deep] = await Promise.all(['Work', 'Plans', 'Deep'].map((v) => box(icon(v))))
  expect(plans!.x - work!.x).toBe(16)
  expect(deep!.x - plans!.x).toBe(16)

  for (const parent of ['Work', 'Plans']) {
    const rowBox = await box(row(page, parent))
    const chevron = await box(row(page, parent).locator('.disclosure'))
    expect(chevron.x).toBeGreaterThanOrEqual(rowBox.x)
    expect(chevron.x + chevron.width).toBeLessThanOrEqual((await box(icon(parent))).x)
  }

  const separator = await page.evaluate(() => {
    const probe = document.createElement('div')
    probe.style.background = 'var(--color-line-separator)'
    document.body.append(probe)
    const color = getComputedStyle(probe).backgroundColor
    probe.remove()
    return color
  })
  const guide = await book(page, 'Plans').evaluate((el) => {
    const style = getComputedStyle(el, '::after')
    return { width: style.width, position: style.position, image: style.backgroundImage }
  })
  expect(guide.width).toBe('1px')
  expect(guide.position).toBe('absolute')
  expect(guide.image).toContain(separator)
})

test('a child row draws its guide per row, and breaks it 2 px clear of its own chevron', async ({
  page,
}) => {
  await setUp(page)
  const guide = (value: string) =>
    book(page, value).evaluate((el) => {
      const style = getComputedStyle(el, '::after')
      const li = el.getBoundingClientRect()
      return {
        x: li.x + parseFloat(style.left),
        image: style.backgroundImage,
      }
    })

  const plans = await guide('Plans')
  const chevron = await box(row(page, 'Plans').locator('.disclosure .chevron'))
  const parentIcon = await box(
    row(page, 'Work').locator(':is(.icon, .icon-svg):not(.disclosure *)'),
  )
  expect(plans.x).toBe(parentIcon.x + parentIcon.width / 2)
  // The line meets the chevron's 14 px box, so it breaks 2 px clear of it: an 18 px gap centred on the row.
  expect(chevron.width).toBe(14)
  expect(plans.x).toBeGreaterThanOrEqual(chevron.x)
  expect(plans.x).toBeLessThanOrEqual(chevron.x + chevron.width)
  expect(plans.image).toContain('calc(50% - 9px)')
  expect(plans.image).toContain('calc(50% + 9px)')

  // A childless row keeps its guide whole.
  const deep = await guide('Deep')
  expect(deep.image).not.toContain('calc(')
})

test('rows answer the pointer, and the selected row and a drop target keep their fill', async ({
  page,
}) => {
  await setUp(page)
  const fill = (token: string) =>
    page.evaluate((name) => {
      const probe = document.createElement('div')
      probe.style.background = `var(${name})`
      document.body.append(probe)
      const color = getComputedStyle(probe).backgroundColor
      probe.remove()
      return color
    }, token)
  const hover = await fill('--color-fill-row-selected-inactive')
  const clear = 'rgba(0, 0, 0, 0)'
  const home = row(page, 'Home')
  await expect(home).toHaveCSS('background-color', clear)
  await home.hover()
  await expect(home).toHaveCSS('background-color', hover)
  await source(page, 'Trash').hover()
  await expect(source(page, 'Trash')).toHaveCSS('background-color', hover)
  await expect(home).toHaveCSS('background-color', clear)

  await row(page, 'Garden').click()
  const selected = await fill('--color-fill-row-selected')
  await expect(row(page, 'Garden')).toHaveCSS('background-color', selected)
  expect(selected).not.toBe(hover)
})

test('the footer is a 20 px capsule 8 px from the sidebar edges, concentric with its corners', async ({
  page,
}) => {
  await setUp(page)
  const side = await box(sidebar(page))
  const toggle = sidebar(page).locator('.footer-toggle')
  const footer = await box(toggle)
  expect(footer.height).toBe(20)
  expect(footer.x - side.x).toBe(8)
  expect(side.x + side.width - (footer.x + footer.width)).toBe(8)
  expect(side.y + side.height - (footer.y + footer.height)).toBe(8)
  const radius = await toggle.evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius))
  expect(radius).toBeGreaterThanOrEqual(10)
})

test('the editor toolbar ends on the keyline, its controls centred in its height', async ({
  page,
}) => {
  await setUp(page)
  const bar = page.locator('.editor-toolbar')
  const outer = await box(bar)
  const width = page.viewportSize()?.width ?? 0
  expect(outer.x + outer.width).toBe(width)
  await expect(bar).toHaveCSS('padding-right', '32px')
  const control = await box(bar.locator('button').first())
  expect(control.y - outer.y).toBe(10)
})

test('Classic keeps its rows, depth and footer, with no fade or guide', async ({ page }) => {
  await setUp(page)
  await changeEditorSettingsElsewhere(page, { sidebarMaterial: false })
  const list = scroller(page)
  await expect(list).toHaveCSS('mask-image', 'none')
  await expect(list).toHaveCSS('overflow-y', 'auto')
  await expect(sidebar(page)).toHaveCSS('padding-inline-start', '10px')
  await expect(sidebar(page)).toHaveCSS('padding-bottom', '12px')
  await expect(source(page, 'All Notes')).toHaveCSS('padding-left', '6px')
  await expect(row(page, 'Work')).toHaveCSS('padding-left', '6px')
  await expect(row(page, 'Plans')).toHaveCSS('padding-left', '24px')
  await expect(sidebar(page).locator('.footer-toggle')).toHaveCSS('height', '30px')
  await list.evaluate((el) => {
    el.scrollTop = 40
  })
  const hairline = await sidebar(page)
    .locator('> .sources')
    .first()
    .evaluate((el) => getComputedStyle(el, '::after').content)
  expect(hairline).toBe('none')
  const guide = await page
    .locator('[role="group"]')
    .first()
    .evaluate((el) => getComputedStyle(el, '::before').content)
  expect(guide).toBe('none')
})
