import { readFileSync } from 'node:fs'
import type { Locator, Page } from '@playwright/test'
import { changeEditorSettingsElsewhere, expect, test } from './fixtures'

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

async function glyphInk(locator: Locator): Promise<Box> {
  return locator.evaluate(async (el) => {
    const bounds = el.getBoundingClientRect()
    const svg = el.tagName.toLowerCase() === 'svg'
    const source = svg
      ? `data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(el))}`
      : getComputedStyle(el).maskImage.slice(5, -2)
    const image = new Image()
    image.src = source
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(bounds.width * 4)
    canvas.height = Math.ceil(bounds.height * 4)
    const context = canvas.getContext('2d')!
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    let left = canvas.width
    let top = canvas.height
    let right = -1
    let bottom = -1
    for (let y = 0; y < canvas.height; y++)
      for (let x = 0; x < canvas.width; x++) {
        if (pixels[(y * canvas.width + x) * 4 + 3]! <= 64) continue
        left = Math.min(left, x)
        top = Math.min(top, y)
        right = Math.max(right, x)
        bottom = Math.max(bottom, y)
      }
    return {
      x: bounds.x + (left / canvas.width) * bounds.width,
      y: bounds.y + (top / canvas.height) * bounds.height,
      width: ((right - left + 1) / canvas.width) * bounds.width,
      height: ((bottom - top + 1) / canvas.height) * bounds.height,
    }
  })
}

async function titleCaps(locator: Locator) {
  return locator.evaluate((el) => {
    const context = document.createElement('canvas').getContext('2d')!
    context.font = getComputedStyle(el).font
    const height = context.measureText('H').actualBoundingBoxAscent
    const baseline = document.createElement('span')
    baseline.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline'
    el.append(baseline)
    const y = baseline.getBoundingClientRect().y
    baseline.remove()
    return { height, centre: y - height / 2 }
  })
}

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

test("the list header's toggle, name and New Note share the toolbars' centre line", async ({
  page,
}) => {
  await newNote(page, 'Plan')
  const header = page.locator('.list-header')
  const toggle = header.locator('.sidebar-toggle')
  const create = header.getByRole('button', { name: 'New Note', exact: true })
  const name = header.locator('.headline')
  const inset = header.locator('.window-inset')
  // The line the traffic lights sit on: the middle of the 52 px toolbars.
  const line = centreY(await box(header))
  expect(line).toBe(26)
  const sameLine = async (what: string, b: Box) =>
    expect(Math.abs(centreY(b) - line), what).toBeLessThanOrEqual(0.5)
  const check = async () => {
    await sameLine('toggle', await box(toggle))
    await sameLine('New Note', await box(create))
    await sameLine('name', await textBox(name))
    for (const button of [toggle, create]) {
      const b = await box(button)
      const icon = await box(button.locator('.icon'))
      expect(Math.abs(icon.x + icon.width / 2 - (b.x + b.width / 2))).toBeLessThanOrEqual(0.5)
      expect(Math.abs(centreY(icon) - centreY(b))).toBeLessThanOrEqual(0.5)
    }
    const room = await box(inset)
    const t = await box(toggle)
    expect(t.x).toBe(room.x + room.width)
    const text = await textBox(name)
    expect(text.x).toBeGreaterThan(t.x + t.width)
    expect(text.x + text.width).toBeLessThan((await box(create)).x)
  }
  await check()
  for (const button of await page.locator('.editor-toolbar .tool').all())
    await sameLine('editor button', await box(button))
  await sameLine('sidebar title bar', await box(page.locator('[data-devot-part=sidebar-titlebar]')))

  await page
    .getByRole('navigation', { name: 'Sidebar' })
    .getByRole('button', { name: /^Trash/ })
    .click()
  await expect(name).toHaveText('Trash')
  const icon = await box(header.locator('.headline-icon'))
  const caps = await titleCaps(name)
  expect(Math.abs(centreY(icon) - caps.centre)).toBeLessThanOrEqual(0.75)

  await page.getByRole('button', { name: 'Hide Sidebar' }).click()
  await expect.poll(async () => (await box(toggle)).x).toBe(84)
  await sameLine('toggle', await box(toggle))
  expect(
    Math.abs(centreY(await box(header.locator('.headline-icon'))) - (await titleCaps(name)).centre),
  ).toBeLessThanOrEqual(0.75)
})

test('title ink follows the text caps in every view and both styles; toolbar ink stays inside its box', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = globalThis as unknown as {
      __TAURI_INTERNALS__: {
        invoke(command: string, args: Record<string, unknown>): Promise<unknown>
      }
    }
    const ipc = w['__TAURI_INTERNALS__']
    const original = ipc.invoke
    ipc.invoke = async (command, args) => {
      if (command !== 'symbol_png') return original(command, args)
      const canvas = document.createElement('canvas')
      canvas.width = 76
      canvas.height = 68
      const context = canvas.getContext('2d')!
      context.fillRect(18, 9, args['name'] === 'doc.on.doc' ? 46 : 36, 39)
      return canvas.toDataURL('image/png').split(',')[1]
    }
  })
  await page.reload()
  await newNote(page, 'Plan')
  const tag = page.getByRole('combobox', { name: 'Add Tag' })
  await tag.fill('urgent')
  await tag.press('Enter')
  await page.getByRole('button', { name: 'New Notebook', exact: true }).click()
  const notebook = page.getByRole('textbox', { name: 'Notebook name' })
  await notebook.fill('Work')
  await notebook.press('Enter')
  const header = page.locator('.list-header')
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' })
  for (const iconStyle of ['sfSymbols', 'lucide'] as const) {
    await changeEditorSettingsElsewhere(page, { iconStyle })
    for (const view of ['Templates', 'Work', 'Active', 'urgent', 'Trash', 'All Notes']) {
      const row =
        view === 'Work'
          ? sidebar.getByRole('treeitem', { name: /^Work\b/ }).locator('> .book-row')
          : sidebar.getByRole('button', { name: new RegExp(`^${view}\\b`) })
      await row.click()
      await expect(header.locator('.headline')).toHaveText(view)
      const caps = await titleCaps(header.locator('.headline'))
      if (view === 'All Notes') {
        await expect(header.locator('.headline-icon')).toHaveCount(0)
        continue
      }
      if (view === 'urgent') {
        const dot = await box(header.locator('.headline-dot'))
        expect(Math.abs(centreY(dot) - caps.centre)).toBeLessThanOrEqual(0.75)
        expect(dot.height).toBeLessThan(caps.height)
        continue
      }
      const glyph = header.locator('.headline-icon > .icon, .headline-icon > svg')
      await expect(glyph).toHaveClass(/icon-title/)
      if (iconStyle === 'sfSymbols') await expect(glyph).not.toHaveCSS('mask-image', 'none')
      const ink = await glyphInk(glyph)
      expect(ink.height / caps.height, `${iconStyle} ${view}`).toBeGreaterThanOrEqual(0.95)
      expect(ink.height / caps.height, `${iconStyle} ${view}`).toBeLessThanOrEqual(1.3)
      expect(Math.abs(centreY(ink) - caps.centre), `${iconStyle} ${view}`).toBeLessThanOrEqual(0.75)
    }
    for (const glyph of await page.locator('.toolbar .tool > .icon, .toolbar .tool > svg').all()) {
      if (!(await glyph.isVisible())) continue
      if (iconStyle === 'sfSymbols') await expect(glyph).not.toHaveCSS('mask-image', 'none')
      const ink = await glyphInk(glyph)
      const frame = await box(glyph)
      expect(ink.width).toBeLessThanOrEqual(frame.width)
      expect(ink.height).toBeLessThanOrEqual(frame.height)
      expect(ink.x).toBeGreaterThanOrEqual(frame.x)
      expect(ink.y).toBeGreaterThanOrEqual(frame.y)
      expect(ink.x + ink.width).toBeLessThanOrEqual(frame.x + frame.width + 0.01)
      expect(ink.y + ink.height).toBeLessThanOrEqual(frame.y + frame.height + 0.01)
    }
  }
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
