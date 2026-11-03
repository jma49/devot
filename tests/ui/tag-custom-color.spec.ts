import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const tagRow = (page: Page, name: string) =>
  sidebar(page).getByRole('button', { name: new RegExp(`^(?:[A-Z][a-z]+ )*${name} \\d+$`) })

async function colourTag(page: Page, name: string, color: string) {
  await page.evaluate(
    ([tag, value]) => {
      const all = JSON.parse(localStorage.getItem('devot.test.tags') ?? '[]') as {
        name: string
        color: string | null
        colorHlc: string
      }[]
      for (const each of all) {
        if (each.name === tag) {
          each.color = value!
          each.colorHlc = '9999999999999999-0000-test'
        }
      }
      localStorage.setItem('devot.test.tags', JSON.stringify(all))
    },
    [name, color] as const,
  )
  await page.reload()
}

async function addTagged(page: Page, ...tags: string[]) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(1)
  for (const tag of tags) {
    const field = page.getByRole('combobox', { name: 'Add Tag' })
    await field.fill(tag)
    await field.press('Enter')
    await expect(tagRow(page, tag)).toBeVisible()
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('a custom colour draws its dot as given on sidebar, chips and list, after a reload', async ({
  page,
}) => {
  await addTagged(page, 'idea')
  await colourTag(page, 'idea', '#ff00aa')

  const given = 'rgb(255, 0, 170)'
  await expect(tagRow(page, 'idea').locator('.tag-dot')).toHaveCSS('background-color', given)
  await expect(tagRow(page, 'idea')).toHaveAccessibleName('Custom Color idea 1')
  await expect(noteRows(page).first().locator('.chip .tag-dot')).toHaveCSS(
    'background-color',
    given,
  )
  await expect(page.getByRole('group', { name: 'Tags' }).locator('.chip .tag-dot')).toHaveCSS(
    'background-color',
    given,
  )

  await page.reload()
  await expect(tagRow(page, 'idea').locator('.tag-dot')).toHaveAttribute('data-color', '#ff00aa')
})

for (const colorScheme of ['light', 'dark'] as const) {
  test(`keeps the given dot and moves the label, on a worst-case colour, ${colorScheme}`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme })
    const worst = colorScheme === 'light' ? '#ffff00' : '#000000'
    await addTagged(page, 'idea')
    await colourTag(page, 'idea', worst)
    const chip = page.getByRole('group', { name: 'Tags' }).locator('.chip')
    const { text, dot } = await chip.evaluate((el) => ({
      text: getComputedStyle(el).color,
      dot: getComputedStyle(el.querySelector('.tag-dot')!).backgroundColor,
    }))
    expect(dot).toBe(colorScheme === 'light' ? 'rgb(255, 255, 0)' : 'rgb(0, 0, 0)')
    expect(text).not.toBe(dot)
  })
}

test('the appearance chosen in Settings picks the label, not the system', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await addTagged(page, 'idea')
  await colourTag(page, 'idea', '#ffff00')
  const chip = page.getByRole('group', { name: 'Tags' }).locator('.chip')
  const label = () => chip.evaluate((el) => getComputedStyle(el).color)
  const onLight = await label()
  await page.evaluate(() => document.documentElement.setAttribute('data-appearance', 'dark'))
  await expect.poll(label).not.toBe(onLight)
})

test('every sidebar tag has one dot, coloured or not', async ({ page }) => {
  await addTagged(page, 'plain', 'palette', 'custom')
  await colourTag(page, 'palette', 'green')
  await colourTag(page, 'custom', '#123456')
  const boxes = await Promise.all(
    ['plain', 'palette', 'custom'].map(async (name) => {
      const dot = tagRow(page, name).locator('.tag-dot')
      await expect(dot).toBeVisible()
      return dot.evaluate((el) => {
        const { width, height, borderRadius, boxShadow } = getComputedStyle(el)
        return { width, height, borderRadius, boxShadow }
      })
    }),
  )
  expect(boxes[1]).toEqual(boxes[0])
  expect(boxes[2]).toEqual(boxes[0])
})
