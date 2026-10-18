import { inflateSync } from 'node:zlib'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const bar = (page: Page) => page.locator('.cm-tooltip.cm-float-bar')
const RADIUS = 14

type Pixels = { width: number; height: number; at: (x: number, y: number) => number[] }

/** Decodes an 8-bit RGB or RGBA PNG (what a screenshot is) into a pixel reader. */
function decodePng(png: Buffer): Pixels {
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  const channels = png[25] === 6 ? 4 : 3
  const chunks: Buffer[] = []
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at)
    if (png.toString('latin1', at + 4, at + 8) === 'IDAT')
      chunks.push(png.subarray(at + 8, at + 8 + length))
    at += 12 + length
  }
  const raw = inflateSync(Buffer.concat(chunks))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i]!
      const a = i >= channels ? out[y * stride + i - channels]! : 0
      const b = y > 0 ? out[(y - 1) * stride + i]! : 0
      const c = y > 0 && i >= channels ? out[(y - 1) * stride + i - channels]! : 0
      const p = a + b - c
      const pa = Math.abs(p - a)
      const pb = Math.abs(p - b)
      const pc = Math.abs(p - c)
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      const add = [0, a, b, (a + b) >> 1, paeth][filter]!
      out[y * stride + i] = (x + add) & 255
    }
  }
  return {
    width,
    height,
    at: (x, y) => [...out.subarray(y * stride + x * channels, y * stride + x * channels + 3)],
  }
}

const distance = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)))

async function selectAt(page: Page, line: number, skip: number) {
  await body(page).click()
  await page.keyboard.press('ControlOrMeta+Home')
  for (let i = 1; i < line; i++) await page.keyboard.press('ArrowDown')
  for (let i = 0; i < skip; i++) await page.keyboard.press('ArrowRight')
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight')
  await expect(bar(page)).toBeVisible()
  // The entrance animation is over when the bar stops moving.
  await expect
    .poll(async () => {
      const a = await bar(page).boundingBox()
      await page.waitForTimeout(120)
      const b = await bar(page).boundingBox()
      return JSON.stringify(a) === JSON.stringify(b)
    })
    .toBe(true)
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`selection bar notch, ${scheme}`, () => {
    test.use({ colorScheme: scheme })

    test.beforeEach(async ({ page }) => {
      await page.goto('/')
      await page.evaluate(() => localStorage.clear())
      await page.reload()
      await page.getByRole('button', { name: 'New Note', exact: true }).click()
      await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
      await body(page).click()
      await page.keyboard.insertText(
        'first line of the note here\nsecond line of the note\nthird line of the note\nfourth line',
      )
    })

    // Line 3 puts the bar above. In Split the panes' sideways scrolling
    // clips above line 1, so the bar goes below it there.
    for (const [placement, line] of [
      ['below', 1],
      ['above', 3],
    ] as const) {
      for (const [where, skip] of [
        ['at the line start', 0],
        ['in the middle of the line', 10],
      ] as const) {
        test(`one continuous shape ${placement} the selection, ${where}`, async ({ page }) => {
          if (placement === 'below') {
            await page
              .getByRole('group', { name: 'View mode' })
              .getByRole('button', { name: 'Split' })
              .click()
          }
          await selectAt(page, line, skip)
          const el = bar(page)
          await expect(el).toHaveClass(new RegExp(`cm-tooltip-${placement}`))
          const box = (await el.boundingBox())!
          const notch = (await el.locator('.cm-float-notch').boundingBox())!
          const fill = await el.evaluate(
            (node) => getComputedStyle(node as unknown as Element).backgroundColor,
          )
          const [r = 0, g = 0, b = 0] = fill.match(/\d+/g)!.map(Number)

          // The notch's base lies on the straight part of the edge, clear of the corners.
          expect(notch.x).toBeGreaterThanOrEqual(box.x + RADIUS)
          expect(notch.x + notch.width).toBeLessThanOrEqual(box.x + box.width - RADIUS)

          const shot = decodePng(await page.screenshot({ scale: 'css' }))
          // The row of the bar's outline: the darkest (or lightest) pixel beside the notch,
          // just past the bar's edge on the notch side.
          const x0 = Math.round(notch.x)
          const x1 = Math.round(notch.x + notch.width)
          const edgeY = Math.round(placement === 'below' ? box.y : box.y + box.height)
          let baseY = edgeY
          let strongest = 0
          for (let y = edgeY - 1; y <= edgeY; y++) {
            const d = distance(shot.at(x0 - 4, y), [r, g, b])
            if (d > strongest) [strongest, baseY] = [d, y]
          }
          expect(strongest, 'the outline is drawn beside the notch').toBeGreaterThan(8)
          // Across the notch base that row is the fill: the notch and the bar are one shape.
          for (let x = x0 + 3; x < x1 - 3; x++)
            expect(distance(shot.at(x, baseY), [r, g, b]), `base pixel ${x}`).toBeLessThanOrEqual(2)

          // Halfway up the notch the two slanted sides are outlined: a pixel differs from the fill
          // within a pixel of each side.
          const midY = Math.round(notch.y + notch.height / 2)
          const cx = notch.x + notch.width / 2
          const reach = notch.width / 4 + 0.5
          for (const side of [-1, 1]) {
            let sides = 0
            for (let dx = -1; dx <= 1; dx++)
              sides = Math.max(
                sides,
                distance(shot.at(Math.round(cx + side * reach) + dx, midY), [r, g, b]),
              )
            expect(sides, `outline on the ${side < 0 ? 'left' : 'right'} side`).toBeGreaterThan(2)
          }
          // The notch's middle is the fill.
          expect(distance(shot.at(Math.round(cx), midY), [r, g, b])).toBeLessThanOrEqual(2)
        })
      }
    }
  })
}
