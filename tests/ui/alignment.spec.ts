import { readFileSync } from 'node:fs'
import type { Locator, Page } from '@playwright/test'
import { changeEditorSettingsElsewhere, expect, test } from './fixtures'

// Edges, centres and spacings that are easy to break without noticing: the
// toolbars and the window's traffic lights, the note list's header and rows,
// the sidebar's row pitch, and the note's text edges in edit and preview.

const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const preview = (page: Page) => page.getByRole('article', { name: 'Preview' })

interface Box {
  x: number
  y: number
  width: number
  height: number
}

async function box(locator: Locator): Promise<Box> {
  const found = await locator.boundingBox()
  if (!found) throw new Error('no box')
  return found
}

const centreY = (b: Box) => b.y + b.height / 2

/** The box of an element's text alone (no padding), on screen. */
const textBox = (locator: Locator): Promise<Box> =>
  locator.evaluate((el) => {
    const g = globalThis as unknown as {
      document: {
        createRange(): {
          selectNodeContents(node: unknown): void
          getBoundingClientRect(): Box
        }
      }
    }
    const range = g.document.createRange()
    range.selectNodeContents(el)
    const r = range.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })

/** Where the first line of an element's text starts, on screen. */
const textStartX = (locator: Locator): Promise<number> =>
  locator.evaluate((el) => {
    const g = globalThis as unknown as {
      document: {
        createRange(): {
          selectNodeContents(node: unknown): void
          getClientRects(): ArrayLike<{ x: number }>
        }
      }
    }
    const range = g.document.createRange()
    range.selectNodeContents(el)
    return range.getClientRects()[0]?.x ?? -1
  })

async function newNote(page: Page, title: string) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(titleField(page)).toHaveValue('')
  await titleField(page).fill(title)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('toolbar buttons sit on the toolbar centre line, and so do the traffic lights', async ({
  page,
}) => {
  await newNote(page, 'Plan')
  const bars = page.locator('[data-devot-part=toolbar], [data-devot-part=sidebar-titlebar]')
  await expect(bars).toHaveCount(3)
  let barCentre = 0
  for (const bar of await bars.all()) {
    const barBox = await box(bar)
    barCentre = barBox.height / 2
    for (const control of await bar.locator('.tool, .segmented').all()) {
      if (!(await control.isVisible())) continue
      expect(Math.abs(centreY(await box(control)) - centreY(barBox))).toBeLessThanOrEqual(1)
    }
  }

  // macOS centres the lights 2 pt above the configured inset (an inset of 20
  // puts their centre at 18): that centre is at most 2 pt from the toolbar's.
  const conf = JSON.parse(
    readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
  ) as { app: { windows: { trafficLightPosition: { x: number; y: number } }[] } }
  const lights = conf.app.windows[0]?.trafficLightPosition
  if (!lights) throw new Error('no traffic light position')
  expect(Math.abs(lights.y - 2 - barCentre)).toBeLessThanOrEqual(2)
})

test('toolbar glyphs are large, and the view modes are 44 by 30 segments', async ({ page }) => {
  await newNote(page, 'Plan')
  const toolbar = page.locator('.editor-toolbar')
  for (const name of ['Focus Mode', 'Back', 'Forward', 'More']) {
    const icon = toolbar.getByRole('button', { name, exact: true }).locator('.icon')
    expect((await box(icon)).width).toBe(22)
  }
  const newNoteIcon = page.getByRole('button', { name: 'New Note', exact: true }).locator('.icon')
  expect((await box(newNoteIcon)).width).toBe(22)

  const modes = toolbar.getByRole('group', { name: 'View mode' })
  const modesBox = await box(modes)
  expect(modesBox.width).toBe(134)
  expect(modesBox.height).toBe(32)
  // Each symbol lies on whole pixels, at the same place in every segment.
  const offsets = new Set<string>()
  for (const segment of await modes.getByRole('button').all()) {
    const b = await box(segment)
    expect(b.width).toBe(44)
    expect(b.height).toBe(30)
    const icon = await box(segment.locator('.icon'))
    expect(icon.width).toBe(17)
    expect(Number.isInteger(icon.x) && Number.isInteger(icon.y)).toBe(true)
    offsets.add(`${icon.x - b.x},${icon.y - b.y}`)
  }
  expect(offsets.size).toBe(1)
})

test("the list header's caption is centred under its title, not under icon and title", async ({
  page,
}) => {
  await newNote(page, 'Plan')
  const header = page.locator('.list-header')
  await expect(header.locator('.headline-row .icon')).toHaveCount(1)
  const title = await textBox(header.locator('.headline'))
  const caption = await textBox(header.locator('.caption'))
  const centreX = (b: Box) => b.x + b.width / 2
  expect(Math.abs(centreX(caption) - centreX(title))).toBeLessThanOrEqual(1)
})

test('a note row insets its title and meta line by the same amount on both sides', async ({
  page,
}) => {
  await newNote(page, 'Plan')
  const row = page.getByRole('listbox', { name: 'Notes' }).getByRole('option').first()
  const rowBox = await box(row)
  for (const part of ['.row-title', '.row-meta']) {
    const b = await box(row.locator(part).first())
    const start = Math.round(b.x - rowBox.x)
    const end = Math.round(rowBox.x + rowBox.width - (b.x + b.width))
    expect(start, part).toBe(15)
    expect(end, part).toBe(15)
  }
})

test('sidebar rows step 30 px with no gap', async ({ page }) => {
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' })
  for (const list of await sidebar.locator('.sources').all()) {
    const rows = await list.locator('.source').all()
    const boxes = await Promise.all(rows.map((r) => box(r)))
    for (const b of boxes) expect(b.height).toBe(30)
    for (let i = 1; i < boxes.length; i++) {
      const prev = boxes[i - 1]
      const next = boxes[i]
      if (!prev || !next) continue
      expect(Math.round(next.y - prev.y)).toBe(30)
    }
  }

  // The footer row has the same height and side padding as the rows above.
  const source = sidebar.locator('.source').first()
  const footer = sidebar.locator('.footer-toggle')
  expect((await box(footer)).height).toBe(30)
  const padding = (l: Locator) => l.evaluate((el) => getComputedStyle(el).paddingLeft)
  expect(await padding(footer)).toBe(await padding(source))
})

test('the note text has the same edges in edit and preview as the title', async ({ page }) => {
  await changeEditorSettingsElsewhere(page, { lineNumbers: false })
  await newNote(page, 'Plan')
  await body(page).click()
  await page.keyboard.insertText('Body text')
  const title = await box(titleField(page))

  await expect(page.locator('.cm-lineNumbers')).toHaveCount(0)
  expect(Math.abs((await textStartX(page.locator('.cm-line').first())) - title.x)).toBeLessThan(1)

  await page
    .locator('.editor-toolbar')
    .getByRole('button', { name: 'Preview', exact: true })
    .click()
  const paragraph = preview(page).locator('p', { hasText: 'Body text' })
  await expect(paragraph).toBeVisible()
  const p = await box(paragraph)
  expect(Math.abs(p.x - title.x)).toBeLessThan(1)
  expect(Math.abs(p.x + p.width - (title.x + title.width))).toBeLessThan(1)
})
