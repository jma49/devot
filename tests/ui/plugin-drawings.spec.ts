import type { Page } from '@playwright/test'
import { expect, openApp, test } from './fixtures'
import { pluginFrame, servePlugins, testPlugin } from './plugins'

// A preview renderer that answers SVG (ADR 0027): the page asks the plugin with the theme on screen, and draws what it
// answers in a box of its own, without scripts and without styles that reach the page. Rust is faked in the page.

const DRAWS = `
devot.preview.handle('dot', (source, theme) => {
  globalThis.themes = [...(globalThis.themes ?? []), theme]
  if (source === 'decline') return null
  if (source === 'broken') return '<p>not a drawing</p>'
  return '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="40">' +
    '<style>rect { fill: ' + theme.colors.series1 + ' } :host { position: fixed; inset: 0 } body { display: none }</style>' +
    '<rect width="160" height="40" /><text x="4" y="24" fill="' + theme.colors.text + '">' + theme.appearance + ' ' + source + '</text>' +
    '<script>top.drawn = 1</script></svg>'
})
`

const graphs = testPlugin(
  'com.example.graphs',
  ['preview'],
  { previewRenderers: [{ id: 'dot', language: 'dot', output: 'svg' }] },
  DRAWS,
)
graphs.manifest['apiVersion'] = 2

const TITLES = `
devot.preview.handle('titles', async () => {
  const notes = await devot.notes.list()
  return '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="20"><text x="4" y="14">' +
    notes.map((n) => n.title).sort().join(', ') + '</text></svg>'
})
`

const index = testPlugin(
  'com.example.index',
  ['preview', 'notes.read'],
  { previewRenderers: [{ id: 'titles', language: 'titles', output: 'svg' }] },
  TITLES,
)
index.manifest['apiVersion'] = 2

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })

async function previewOf(page: Page, text: string) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await body(page).click()
  await page.keyboard.insertText(text)
  await page.keyboard.press('Meta+KeyE')
  return page.locator('.preview')
}

test.use({ colorScheme: 'light' })

test.beforeEach(async ({ page }) => {
  await servePlugins(page, [graphs, index])
  await openApp(page)
  await pluginFrame(page, 'com.example.graphs')
})

test('draws a block as the plugin’s SVG, for the theme on screen, kept inside its box', async ({
  page,
}) => {
  const preview = await previewOf(page, 'Before\n\n```dot\na -> b\n```\n')
  const drawing = preview.locator('.plugin-drawing')
  await expect(drawing.getByRole('img', { name: 'Drawing from a plugin' })).toBeVisible()
  await expect(drawing.locator('text')).toHaveText('light a -> b')
  const frame = await pluginFrame(page, 'com.example.graphs')
  const sent = (await frame.evaluate(
    () => (globalThis as { themes?: { colors: Record<string, string> }[] }).themes,
  ))!.at(-1)!
  expect(sent.colors['series1']).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/)
  const fill = await drawing.locator('rect').evaluate((r) => getComputedStyle(r).fill)
  const expected = await page.evaluate((hex) => {
    const probe = document.createElement('div')
    probe.style.color = hex
    document.body.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  }, sent.colors['series1']!)
  expect(fill).toBe(expected)
  expect(await drawing.evaluate((d) => getComputedStyle(d).position)).toBe('static')
  await expect(preview.getByText('Before')).toBeVisible()
  await expect(drawing.locator('script')).toHaveCount(0)
  expect(await page.evaluate(() => (globalThis as { drawn?: number }).drawn)).toBeUndefined()
})

test('shows a declined block as code, and says so when a drawing cannot be read', async ({
  page,
}) => {
  const preview = await previewOf(page, '```dot\ndecline\n```\n\n```dot\nbroken\n```\n')
  await expect(preview.locator('pre code').getByText('decline')).toBeVisible()
  await expect(preview.getByRole('note')).toHaveText('The plugin could not draw this block.')
})

test('draws a block that lists notes again once the notes change', async ({ page }) => {
  await pluginFrame(page, 'com.example.index')
  const preview = await previewOf(page, '```titles\n```\n')
  const title = page.getByRole('textbox', { name: 'Title' })
  await title.fill('Alpha')
  const drawing = preview.locator('.plugin-drawing text')
  await expect(drawing).toHaveText('Alpha')
  await title.fill('Beta')
  await expect(drawing).toHaveText('Beta')
})
