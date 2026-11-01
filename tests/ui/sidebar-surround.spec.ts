import { decodePng } from '../support/png'
import { expect, openSettings, test } from './fixtures'

for (const colorScheme of ['light', 'dark'] as const) {
  for (const settings of [false, true]) {
    test.describe(`${colorScheme} ${settings ? 'Settings' : 'library'} sidebar surround`, () => {
      test.use({ colorScheme, viewport: { width: 1280, height: 760 } })

      test('fills all four outer corners without painting under the rounded glass', async ({
        page,
      }) => {
        if (settings) await openSettings(page, 'Appearance')
        else await page.goto('/')
        const sidebar = page.locator(settings ? '.settings-nav' : '.window > .sidebar')
        await expect(sidebar).toBeVisible()
        await page.evaluate(() => {
          document.documentElement.style.background = 'rgb(200, 30, 80)'
        })
        for (const viewport of [
          { width: 1280, height: 760 },
          { width: 1200, height: 680 },
        ]) {
          await page.setViewportSize(viewport)
          const box = await sidebar.boundingBox()
          if (!box) throw new Error('E_TEST_SIDEBAR_MISSING')
          const width = Math.round(box.x + box.width + 8)
          await expect
            .poll(() =>
              page
                .locator('html')
                .evaluate((el) => el.style.getPropertyValue('--sidebar-surround-clip')),
            )
            .toContain(`H${viewport.width}V${viewport.height}H0Z`)
          await page.evaluate(() => {
            document.documentElement.dataset['nativeGlass'] = 'on'
          })
          const png = decodePng(await page.screenshot({ scale: 'css' }))
          const pixel = (x: number, y: number) => {
            const at = (y * png.width + x) * png.channels
            return [...png.pixels.slice(at, at + 3)]
          }
          const sheet = pixel(width + 4, 2)
          for (const x of [2, width - 3]) {
            for (const y of [2, viewport.height - 3]) {
              expect(
                Math.max(...pixel(x, y).map((channel, i) => Math.abs(channel - sheet[i]!))),
              ).toBeLessThanOrEqual(1)
            }
          }
          expect(pixel(Math.round(box.x + box.width / 2), Math.round(box.y + 18))).toEqual([
            200, 30, 80,
          ])
        }
      })
    })
  }
}
