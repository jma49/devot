import type { Page } from '@playwright/test'
import { expect, test, type TestWindow } from './fixtures'

async function newNote(page: Page, title: string, body = '') {
  const before = await page.getByRole('listbox', { name: 'Notes' }).getByRole('option').count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  // Wait for the new note to open, or the title lands on the previous one.
  await expect(page.getByRole('listbox', { name: 'Notes' }).getByRole('option')).toHaveCount(
    before + 1,
  )
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
  if (body) {
    await page.getByRole('textbox', { name: 'Note body' }).click()
    // Inserted at once, so the editor's bracket helpers do not interfere.
    await page.keyboard.insertText(body)
  }
}

const preview = (page: Page) => page.getByRole('article', { name: 'Preview' })
const mode = (page: Page, name: 'Edit' | 'Split' | 'Preview') =>
  page.getByRole('group', { name: 'View mode' }).getByRole('button', { name })

test.beforeEach(async ({ page }) => {
  // Embeds must never reach the network in tests.
  await page.route(/^https:\/\//, (route) => route.abort())
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('switches between edit, split and preview', async ({ page }) => {
  await newNote(page, 'Modes', '# Hello\n\nSome *text*.')
  const body = page.getByRole('textbox', { name: 'Note body' })

  await expect(mode(page, 'Edit')).toHaveAttribute('aria-pressed', 'true')
  await expect(preview(page)).toHaveCount(0)

  await mode(page, 'Split').click()
  await expect(mode(page, 'Split')).toHaveAttribute('aria-pressed', 'true')
  await expect(body).toBeVisible()
  await expect(preview(page).getByRole('heading', { name: 'Hello' })).toBeVisible()
  await expect(preview(page).locator('em')).toHaveText('text')

  await mode(page, 'Preview').click()
  await expect(body).toBeHidden()
  await expect(preview(page).getByRole('heading', { name: 'Hello' })).toBeVisible()

  await mode(page, 'Edit').click()
  await expect(preview(page)).toHaveCount(0)
  await expect(body).toBeVisible()
})

test('updates the preview by patching only the nodes that changed', async ({ page }) => {
  await newNote(page, 'Patch', '# Stable heading\n\nFirst paragraph.')
  await mode(page, 'Split').click()
  const heading = preview(page).getByRole('heading', { name: 'Stable heading' })
  await expect(heading).toBeVisible()
  await heading.evaluate((el) => Object.assign(el, { devotMark: true }))

  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.press('Meta+ArrowDown')
  await page.keyboard.insertText('\n\nSecond paragraph.')
  await expect(preview(page)).toContainText('Second paragraph.')
  expect(await heading.evaluate((el) => (el as unknown as { devotMark?: boolean }).devotMark)).toBe(
    true,
  )
})

test('note content never runs scripts', async ({ page }) => {
  await newNote(
    page,
    'Hostile',
    '<img src=x onerror="window.devotXss=1">\n\n<a href="javascript:window.devotXss=2">click</a>\n\n<script>window.devotXss=3</script>',
  )
  await mode(page, 'Split').click()
  await expect(preview(page).getByText('click')).toBeVisible()
  await preview(page).getByText('click').click()
  await page.waitForTimeout(200)
  expect(await page.evaluate(() => (globalThis as { devotXss?: number }).devotXss)).toBeUndefined()
})

test('a note link opens that note', async ({ page }) => {
  await newNote(page, 'Target')
  await newNote(page, 'Source')
  const target = await page.evaluate(() => {
    const notes = JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as {
      id: string
      title: string
    }[]
    return notes.find((n) => n.title === 'Target')?.id
  })
  expect(target).toBeTruthy()
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.insertText(`Go to [the target](devot://note/${target}).`)
  await mode(page, 'Split').click()
  await preview(page).getByRole('link', { name: 'the target' }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Target')
})

test('https links open in the system browser', async ({ page }) => {
  await newNote(page, 'Links', 'Visit [the site](https://example.com/page).')
  await mode(page, 'Split').click()
  await preview(page).getByRole('link', { name: 'the site' }).click()
  await expect
    .poll(() => page.evaluate(() => (globalThis as unknown as TestWindow).devotIpcCalls))
    .toContainEqual({ cmd: 'open_external', args: { url: 'https://example.com/page' } })
  await expect(page).toHaveURL(/localhost/)
})

test('a link to a heading scrolls the preview to it', async ({ page }) => {
  const filler = Array.from({ length: 60 }, (_, i) => `Line ${i}\n`).join('\n')
  await newNote(page, 'Anchors', `[Jump](#the-end)\n\n${filler}\n## The End\n\nDone.`)
  await mode(page, 'Preview').click()
  const heading = preview(page).getByRole('heading', { name: 'The End' })
  await expect(heading).toHaveAttribute('id', 'the-end')
  await expect(heading).not.toBeInViewport()
  await preview(page).getByRole('link', { name: 'Jump' }).click()
  await expect(heading).toBeInViewport()
})

test('embeds from unknown origins load only on click, sandboxed', async ({ page }) => {
  await newNote(page, 'Embed', '<iframe src="https://example.com/widget"></iframe>')
  await mode(page, 'Split').click()
  await expect(preview(page).getByText('Embedded content from example.com')).toBeVisible()
  await expect(preview(page).locator('iframe')).toHaveCount(0)

  await preview(page).getByRole('button', { name: 'Load' }).click()
  const frame = preview(page).locator('iframe')
  await expect(frame).toHaveAttribute('src', 'https://example.com/widget')
  const sandbox = await frame.getAttribute('sandbox')
  expect(sandbox?.split(' ')).not.toContain('allow-top-navigation')
  expect(sandbox?.split(' ')).toContain('allow-scripts')
  await expect(frame).toHaveAttribute('referrerpolicy', 'strict-origin-when-cross-origin')
})

test('a colour in inline code shows a swatch', async ({ page }) => {
  await newNote(page, 'Colours', 'Accent: `#ff0000`')
  await mode(page, 'Split').click()
  const swatch = preview(page).locator('.swatch')
  await expect(swatch).toHaveCSS('background-color', 'rgb(255, 0, 0)')
})

test('math renders as MathML and emoji shortcodes as emoji', async ({ page }) => {
  await newNote(page, 'Math', 'Inline $a^2 + b^2$ and :tada:\n\n$$\n\\frac{1}{2}\n$$')
  await mode(page, 'Split').click()
  const inline = preview(page).locator('.math-inline math')
  await expect(inline).toHaveCount(1)
  expect(await inline.evaluate((el) => el.namespaceURI)).toBe('http://www.w3.org/1998/Math/MathML')
  await expect(preview(page).locator('.math-display mfrac')).toHaveCount(1)
  await expect(preview(page)).toContainText('\u{1F389}')
})

const DIAGRAM = '```mermaid\ngraph TD\n  Start --> Finish\n```'

test('mermaid loads only for notes with a diagram, then draws it', async ({ page }) => {
  const requests: string[] = []
  // Without the checkout's own path, which may contain the word.
  page.on('request', (r) => requests.push(r.url().replaceAll(process.cwd(), '')))
  await newNote(page, 'Plain', '# No diagrams here')
  await mode(page, 'Split').click()
  await expect(preview(page).getByRole('heading', { name: 'No diagrams here' })).toBeVisible()
  expect(requests.filter((u) => /mermaid/i.test(u))).toEqual([])

  await newNote(page, 'Diagram', DIAGRAM)
  const svg = preview(page).locator('.island-mermaid svg')
  await expect(svg).toHaveCount(1)
  await expect(svg).toContainText('Start')
  expect(requests.some((u) => /mermaid/i.test(u))).toBe(true)
  await expect(preview(page).locator('style')).toHaveCount(0)
})

test('an invalid diagram shows an error in place', async ({ page }) => {
  await newNote(page, 'Broken', '```mermaid\ngraph TD\n  A -->\n```\n\nAfter the diagram.')
  await mode(page, 'Split').click()
  await expect(preview(page).locator('.island-error')).toHaveText(
    'This diagram has an error and cannot be drawn.',
  )
  await expect(preview(page)).toContainText('After the diagram.')
})

test('diagrams keep their styles under a CSP without inline styles', async ({ page, baseURL }) => {
  await page.route(`${baseURL}/`, async (route) => {
    const response = await route.fetch()
    await route.fulfill({
      response,
      headers: { ...response.headers(), 'content-security-policy': "style-src 'self'" },
    })
  })
  await page.goto('/')
  await newNote(page, 'Strict', DIAGRAM)
  await mode(page, 'Split').click()
  type Styles = { getComputedStyle(el: unknown): { fill: string; width: string } }
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' })
  expect(
    await sidebar.evaluate((el) => (globalThis as unknown as Styles).getComputedStyle(el).width),
  ).not.toBe('200px')

  const node = preview(page).locator('.island-mermaid svg .node rect').first()
  await expect(node).toBeVisible()
  await expect
    .poll(() => node.evaluate((el) => (globalThis as unknown as Styles).getComputedStyle(el).fill))
    .not.toBe('rgb(0, 0, 0)')
})

const FLOWCHART = '```mermaid\ngraph TD\n  Start --> Finish\n```'
const SECOND_FLOWCHART = '```mermaid\nflowchart LR\n  Draft --> Review --> Done\n```'
const SEQUENCE = '```mermaid\nsequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi\n```'

for (const [name, second] of [
  ['two flowcharts', SECOND_FLOWCHART],
  ['a flowchart and a sequence diagram', SEQUENCE],
] as const) {
  test(`${name} requested together both draw`, async ({ page }) => {
    await newNote(page, 'Together', `${FLOWCHART}\n\nBetween.\n\n${second}\n`)
    await mode(page, 'Split').click()
    const svgs = preview(page).locator('.island-mermaid svg')
    await expect(svgs).toHaveCount(2, { timeout: 20_000 })
    await expect(preview(page).locator('.island-error')).toHaveCount(0)
    await expect(svgs.first()).toContainText('Start')
    await expect(svgs.nth(1)).toContainText(second === SEQUENCE ? 'Alice' : 'Review')
  })
}

const adoptedSheets = (page: Page) =>
  page.evaluate(
    () =>
      (globalThis as unknown as { document: { adoptedStyleSheets: unknown[] } }).document
        .adoptedStyleSheets.length,
  )

test('a diagram drawn again releases the styles of the one it replaces', async ({ page }) => {
  await newNote(page, 'Sheets', FLOWCHART)
  const before = await adoptedSheets(page)
  await mode(page, 'Split').click()
  const svg = preview(page).locator('.island-mermaid svg')
  await expect(svg).toHaveCount(1)
  await expect.poll(() => adoptedSheets(page)).toBe(before + 1)

  await svg.evaluate((el) => el.setAttribute('data-test-first', ''))
  for (const colorScheme of ['dark', 'light', 'dark', 'light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
  }
  await expect(preview(page).locator('.island-mermaid svg:not([data-test-first])')).toHaveCount(1, {
    timeout: 20_000,
  })
  await expect(preview(page).locator('.island-error')).toHaveCount(0)
  expect(await adoptedSheets(page)).toBe(before + 1)

  await mode(page, 'Edit').click()
  await expect(preview(page)).toHaveCount(0)
  await expect.poll(() => adoptedSheets(page)).toBe(before)
})

async function mermaidFrame(page: Page) {
  await expect.poll(() => page.frames().some((f) => /mermaid\.html/.test(f.url()))).toBe(true)
  return page.frames().find((f) => /mermaid\.html/.test(f.url()))!
}

async function appendToNote(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText(text)
}

test('a diagram library that loads slowly does not use up the time to draw', async ({ page }) => {
  await page.clock.install()
  // The frame's page is held back until longer than a drawing may take.
  let load!: () => void
  const loaded = new Promise<void>((resolve) => (load = resolve))
  await page.route(/\/mermaid\.html/, async (route) => {
    await loaded
    await route.continue()
  })
  await newNote(page, 'Slow', FLOWCHART)
  const asked = page.waitForRequest(/\/mermaid\.html/)
  await mode(page, 'Split').click()
  await asked
  await page.clock.runFor(11_000)
  load()
  await expect(preview(page).locator('.island-mermaid svg')).toHaveCount(1, { timeout: 20_000 })
  await expect(preview(page).locator('.island-error')).toHaveCount(0)
})

test('a diagram that fails to draw for a passing reason is asked for again', async ({ page }) => {
  const warnings: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'warning') warnings.push(m.text())
  })
  await newNote(page, 'Passing', FLOWCHART)
  await mode(page, 'Split').click()
  const svgs = preview(page).locator('.island-mermaid svg')
  await expect(svgs).toHaveCount(1)

  const frame = await mermaidFrame(page)
  await frame.evaluate(() => {
    type Body = { appendChild: (node: unknown) => unknown }
    const body = (globalThis as unknown as { document: { body: Body } }).document.body
    const original = body.appendChild
    body.appendChild = () => {
      body.appendChild = original
      throw new Error('test')
    }
  })
  await appendToNote(page, `\n\n${SECOND_FLOWCHART}\n`)
  const error = preview(page).locator('.island-error')
  await expect(error).toHaveText(
    'This diagram could not be drawn. It is tried again when the note changes.',
  )
  expect(warnings).toContain('W_MERMAID_FAILED render')

  await appendToNote(page, '\nAfter.\n')
  await expect(svgs).toHaveCount(2, { timeout: 20_000 })
  await expect(error).toHaveCount(0)
  await expect(svgs.nth(1)).toContainText('Review')
})

test('a diagram whose drawing cannot be read is not promised again', async ({ page }) => {
  const warnings: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'warning') warnings.push(m.text())
  })
  await newNote(page, 'Unreadable', FLOWCHART)
  await mode(page, 'Split').click()
  const svgs = preview(page).locator('.island-mermaid svg')
  await expect(svgs).toHaveCount(1)

  const frame = await mermaidFrame(page)
  await frame.evaluate(() => {
    type Port = { postMessage(message: unknown, ...rest: unknown[]): void }
    const proto = (globalThis as unknown as { MessagePort: { prototype: Port } }).MessagePort
      .prototype
    const original = proto.postMessage
    proto.postMessage = function (this: Port, message: unknown, ...rest: unknown[]) {
      const m = message as { type?: string }
      if (m.type !== 'rendered') return original.call(this, message, ...rest)
      proto.postMessage = original
      return original.call(this, { ...m, svg: '<html/>' }, ...rest)
    }
  })
  await appendToNote(page, `\n\n${SECOND_FLOWCHART}\n`)
  const error = preview(page).locator('.island-error')
  await expect(error).toHaveText('This diagram cannot be drawn.')
  expect(warnings).toContain('W_MERMAID_FAILED svg')

  await appendToNote(page, `\nAfter.\n\n${SEQUENCE}\n`)
  await expect(svgs).toHaveCount(2, { timeout: 20_000 })
  await expect(svgs.nth(1)).toContainText('Alice')
  await expect(error).toHaveText('This diagram cannot be drawn.')
})
