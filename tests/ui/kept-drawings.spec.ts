import { createHash } from 'node:crypto'
import type { Page } from '@playwright/test'
import { expect, openApp, test } from './fixtures'

// A plugin drawing kept with its note (ADR 0030), shown in a window without the plugin, as on a phone: rebuilt
// through the allowlist, and code again once the block changes. Rust is faked in the page; no plugin is installed.

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const hash = (content: string) => createHash('sha256').update(content).digest('hex')

const KEPT =
  '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="40">' +
  '<style>:host { position: fixed; inset: 0 } text { fill: rgb(1, 2, 3) }</style>' +
  '<text x="4" y="24">kept a -&gt; b</text>' +
  '<foreignObject><div>outside</div></foreignObject><image href="https://tracker.example/i.png" />' +
  '<script>top.keptRan = 1</script></svg>'

test.use({ colorScheme: 'light' })

async function noteWithKeptDrawing(page: Page) {
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await body(page).click()
  await page.keyboard.insertText('Before\n\n```dot\na -> b\n```\n')
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as {
              id: string
              bodyMd: string
            }[]
          ).find((n) => n.bodyMd.includes('a -> b'))?.id ?? null,
      ),
    )
    .not.toBeNull()
  await page.evaluate(
    ({ svg, blockHash }) => {
      const notes = JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as {
        id: string
        bodyMd: string
      }[]
      const noteId = notes.find((n) => n.bodyMd.includes('a -> b'))!.id
      const drawing = {
        pluginId: 'com.example.graphs',
        language: 'dot',
        hash: blockHash,
        appearance: 'light',
        svg,
      }
      localStorage.setItem(
        'devot.test.noteDrawings',
        JSON.stringify([{ noteId, drawings: [drawing], hlc: '0001728000000000-0000-mac' }]),
      )
      window.dispatchEvent(new CustomEvent('devot:db-changed'))
    },
    { svg: KEPT, blockHash: hash('a -> b') },
  )
}

test('shows the kept drawing of a block without its plugin, rebuilt inside its box', async ({
  page,
}) => {
  await noteWithKeptDrawing(page)
  await page.keyboard.press('Meta+KeyE')
  const preview = page.locator('.preview')
  const drawing = preview.locator('.plugin-drawing')
  await expect(drawing.getByRole('img', { name: 'Drawing from a plugin' })).toBeVisible()
  await expect(drawing.locator('text')).toHaveText('kept a -> b')
  expect(await drawing.locator('text').evaluate((t) => getComputedStyle(t).fill)).toBe(
    'rgb(1, 2, 3)',
  )
  expect(await drawing.evaluate((d) => getComputedStyle(d).position)).toBe('static')
  await expect(drawing.locator('script, foreignObject, image')).toHaveCount(0)
  await expect(drawing.getByRole('button', { name: 'Edit' })).toHaveCount(0)
  await expect(preview.getByText('Before')).toBeVisible()
  expect(await page.evaluate(() => (globalThis as { keptRan?: number }).keptRan)).toBeUndefined()
})

test('shows the block as code with a note once it no longer matches its drawing', async ({
  page,
}) => {
  await noteWithKeptDrawing(page)
  await page.keyboard.press('Meta+KeyE')
  const preview = page.locator('.preview')
  await expect(preview.locator('.plugin-drawing')).toBeVisible()
  await page.keyboard.press('Meta+KeyE')
  await body(page).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText('Before\n\n```dot\na -> c\n```\n')
  await page.keyboard.press('Meta+KeyE')
  await expect(preview.locator('pre code').getByText('a -> c')).toBeVisible()
  await expect(
    preview.getByText('This drawing updates on a Mac where its plugin is installed.'),
  ).toBeVisible()
  await expect(preview.locator('.plugin-drawing')).toHaveCount(0)
})
