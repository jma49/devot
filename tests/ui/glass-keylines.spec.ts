import type { Locator, Page } from '@playwright/test'
import { changeEditorSettingsElsewhere, expect, openApp, pickMenuItem, test } from './fixtures'

test.use({ viewport: { width: 1280, height: 820 } })

const left = async (locator: Locator): Promise<number> => {
  const found = await locator.boundingBox()
  if (!found) throw new Error('no box')
  return found.x
}
const right = async (locator: Locator): Promise<number> => {
  const found = await locator.boundingBox()
  if (!found) throw new Error('no box')
  return found.x + found.width
}
const inkLeft = (locator: Locator): Promise<number> =>
  locator.evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    return range.getBoundingClientRect().left
  })

async function noteWithBody(page: Page, title: string, text: string) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.insertText(text)
}

const viewMode = (page: Page, name: string) =>
  page.locator('.editor-toolbar').getByRole('button', { name, exact: true }).click()

test.beforeEach(async ({ page }) => {
  await openApp(page)
})

test('the note list has two left edges and one right edge', async ({ page }) => {
  await noteWithBody(page, 'Plain one', 'Text')
  const list = page.locator('.list')
  const origin = await left(list)
  const listRight = await right(list)
  const from = async (l: Locator) =>
    Math.round((await l.evaluate((el) => el.getBoundingClientRect().left)) - origin)

  expect(await from(list.locator('.search-field'))).toBe(12)
  expect(await from(list.locator('.row').first())).toBe(12)
  expect(Math.round((await inkLeft(list.locator('.sort-chip'))) - origin)).toBe(24)
  expect(Math.round((await inkLeft(list.locator('.row-title').first())) - origin)).toBe(24)
  expect(await from(list.locator('.sidebar-toggle, .list-header-side').first())).toBe(12)

  for (const end of [
    list.locator('.search-field'),
    list.locator('.layout-control'),
    list.locator('.row').first(),
  ]) {
    expect(Math.round(listRight - (await right(end)))).toBe(12)
  }
})

test('every sidebar row has its icon at 18 and its label at 44, chevron or not', async ({
  page,
}) => {
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' })
  await page.getByRole('button', { name: 'New Notebook' }).click()
  const field = page.getByRole('textbox', { name: 'Notebook name' })
  await field.fill('Parent')
  await field.press('Enter')
  const tree = page.getByRole('tree', { name: 'Notebooks' })
  const parent = tree.getByRole('treeitem', { name: /^Parent\b/ })
  await parent.locator('> .book-row').click({ button: 'right' })
  await pickMenuItem(page, 'New Notebook Inside')
  await field.fill('Child')
  await field.press('Enter')
  const child = tree.getByRole('treeitem', { name: /^Child\b/ })
  await expect(child).toBeVisible()

  const origin = await left(sidebar)
  const all = sidebar.getByRole('button', { name: /^All Notes\b/ })
  for (const row of [all, parent.locator('> .book-row')]) {
    expect(Math.round((await left(row)) - origin)).toBe(8)
    expect(
      Math.round((await left(row.locator('.icon, .icon-svg, .book-icon').last())) - origin),
    ).toBe(18)
    expect(Math.round((await left(row.locator('.source-label'))) - origin)).toBe(44)
  }
  const statusRow = sidebar.getByRole('button', { name: /^Active\b/ })
  expect(Math.round((await left(statusRow.locator('.source-label'))) - origin)).toBe(44)

  const childLabel = child.locator('> .book-row .source-label')
  expect(Math.round((await left(childLabel)) - origin)).toBe(44 + 16)

  const chevron = parent.locator('> .book-row > .disclosure')
  expect(await right(chevron)).toBeLessThanOrEqual(origin + 18 + 1)

  const caption = sidebar.locator('.section-header').first().locator('span').first()
  expect(Math.round((await inkLeft(caption)) - origin)).toBe(18)
})

test('toolbar controls are 32 pt capsules centred on y = 26', async ({ page }) => {
  await noteWithBody(page, 'Plan', 'Text')
  for (const name of ['Focus Mode', 'More', 'New Note']) {
    const b = await page.getByRole('button', { name, exact: true }).first().boundingBox()
    expect(b?.height, name).toBe(32)
    expect((b?.y ?? 0) + (b?.height ?? 0) / 2, name).toBe(26)
  }
  await expect(page.locator('.list .search-field')).toHaveCSS('height', '32px')
})

test('toolbar groups start and end on the note keylines, in every view', async ({ page }) => {
  await changeEditorSettingsElsewhere(page, { lineNumbers: false })
  const code = '```\nno highlighting\n```'
  const long = Array.from({ length: 60 }, (_, i) => `Paragraph ${i}\n`).join('\n')
  await noteWithBody(page, 'Plan', `${code}\n\n${long}`)
  const content = page.locator('.content')
  const toolbar = page.locator('.editor-toolbar')
  const first = toolbar.locator('> *:visible').first()
  const last = toolbar.locator('> *:visible').last()
  const contentLeft = await left(content)
  const contentRight = await right(content)

  expect(Math.round((await left(first)) - contentLeft)).toBe(32)
  expect(Math.round(contentRight - (await right(last)))).toBe(32)
  expect(Math.abs((await left(page.locator('.title'))) - (await left(first)))).toBeLessThan(1)
  expect(Math.abs((await left(page.locator('.note-meta'))) - (await left(first)))).toBeLessThan(1)

  await viewMode(page, 'Preview')
  const block = page.locator('.preview pre').first()
  await expect(block).toBeVisible()
  expect(Math.abs((await left(block)) - (await left(first)))).toBeLessThan(1)
  expect(Math.abs((await right(block)) - (await right(last)))).toBeLessThan(1)

  await viewMode(page, 'Split')
  const panes = page.locator('.panes-split')
  await expect(panes).toBeVisible()
  const previewPane = page.locator('.panes-split > .preview')
  expect(
    Math.abs((await left(page.locator('.preview pre').first())) - (await left(previewPane)) - 32),
  ).toBeLessThan(1)
  expect(Math.abs((await right(block)) - (await right(last)))).toBeLessThan(1)
  const line = page.locator('.cm-line', { hasText: 'Paragraph 0' })
  expect(Math.abs((await inkLeft(line)) - (await left(first)))).toBeLessThan(1)
})

test('Classic keeps its own edges', async ({ page }) => {
  await changeEditorSettingsElsewhere(page, { sidebarMaterial: false })
  await noteWithBody(page, 'Plan', 'Text')
  await expect(page.locator('.editor-toolbar')).toHaveCSS('padding-left', '16px')
  await expect(page.locator('.title')).toHaveCSS('margin-left', '24px')
  await expect(page.locator('.list-filter')).toHaveCSS('padding-left', '12px')
})

test('the notebook name field fills the sidebar row', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'New Notebook' }).click()
  const field = page.getByRole('textbox', { name: 'Notebook name' })
  await expect(field).toBeVisible()
  await expect(field).toHaveCSS('justify-self', 'stretch')
})
