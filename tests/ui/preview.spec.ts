import type { Page } from '@playwright/test'
import { FRAME_IDLE_MS } from '../../src/renderer/src/preview/frameLifetime'
import { expect, test, openApp } from './fixtures'

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
  await openApp(page)
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
    .poll(() => page.evaluate(() => window.devotIpcCalls))
    .toContainEqual({ cmd: 'open_external', args: { url: 'https://example.com/page' } })
  await expect(page).toHaveURL(/localhost/)
})

test('a link to a heading scrolls the preview to it', async ({ page }) => {
  const filler = Array.from({ length: 60 }, (_, i) => `Line ${i}\n`).join('\n')
  await newNote(page, 'Anchors', `[Jump](#the-end)\n\n${filler}\n## The End\n\nDone.`)
  await mode(page, 'Preview').click()
  const heading = preview(page).getByRole('heading', { name: 'The End' })
  await expect(heading).toHaveAttribute('id', 'user-content-the-end')
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

const TRACKED = [
  '```mermaid\n%%{init: {"themeCSS": ".label{background-image:url(https://tracker.example/h.png)} svg{background:url(https://tracker.example/i.png)}"}}%%\nflowchart TD\n  A[Fake] --> B\n```',
  '```mermaid\n---\nconfig:\n  themeCSS: ".node rect{fill:url(https://tracker.example/b.png)}"\n---\nflowchart TD\n  C[Front] --> D\n```',
].join('\n\n')

test("a diagram's CSS loads nothing from the web", async ({ page }) => {
  const requests: string[] = []
  page.on('request', (r) => requests.push(r.url()))
  await newNote(page, 'Tracked', TRACKED)
  await mode(page, 'Preview').click()
  const svgs = preview(page).locator('.island-mermaid svg')
  await expect(svgs).toHaveCount(2, { timeout: 20_000 })
  await expect(svgs.first()).toContainText('Fake')
  const css = await page.evaluate(() => {
    const doc = (globalThis as unknown as { document: Document }).document
    const rules = doc.adoptedStyleSheets.flatMap((sheet) =>
      Array.from(sheet.cssRules, (rule) => rule.cssText),
    )
    const inline = Array.from(doc.querySelectorAll('.island-mermaid [style]'), (el) =>
      el.getAttribute('style'),
    )
    return [...rules, ...inline].join('\n')
  })
  expect(css).not.toContain('tracker.example')
  // Two frames, so anything the drawings would fetch has been asked for.
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  )
  expect(requests.filter((url) => url.includes('tracker.example'))).toEqual([])
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

const adoptedSheets = (page: Page) => page.evaluate(() => window.document.adoptedStyleSheets.length)

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

test('the diagram frame goes a while after the last note with a diagram is left', async ({
  page,
}) => {
  await page.clock.install()
  await newNote(page, 'Second', SECOND_FLOWCHART)
  await newNote(page, 'Plain', 'No diagram here.')
  await newNote(page, 'Drawn', FLOWCHART)
  await mode(page, 'Split').click()
  const svgs = preview(page).locator('.island-mermaid svg')
  await expect(svgs).toHaveCount(1, { timeout: 20_000 })
  const frame = page.locator('iframe.mermaid-frame')
  await expect(frame).toHaveCount(1)

  const notes = page.getByRole('listbox', { name: 'Notes' })
  await notes.getByRole('option', { name: /Plain/ }).click()
  await expect(preview(page)).toContainText('No diagram here.')
  await expect(svgs).toHaveCount(0)
  await page.clock.runFor(FRAME_IDLE_MS - 1000)
  await expect(frame).toHaveCount(1)
  await page.clock.runFor(2000)
  await expect(frame).toHaveCount(0)

  await notes.getByRole('option', { name: /Drawn/ }).click()
  await expect(svgs).toHaveCount(1, { timeout: 20_000 })
  await expect(frame).toHaveCount(0)

  await notes.getByRole('option', { name: /Second/ }).click()
  await expect(svgs).toContainText('Review', { timeout: 20_000 })
  await expect(frame).toHaveCount(1)
  await expect(preview(page).locator('.island-error')).toHaveCount(0)
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

  // The frame's next drawing fails before Mermaid runs (as when it runs out of memory).
  const frame = await mermaidFrame(page)
  await frame.evaluate(() => {
    const body = window.document.body
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

  // The frame's next drawing reaches the preview as something other than SVG.
  const frame = await mermaidFrame(page)
  await frame.evaluate(() => {
    const proto = MessagePort.prototype
    const original = proto.postMessage
    proto.postMessage = function (this: MessagePort, message: unknown, ...rest: unknown[]) {
      const m = message as { type?: string }
      if (m.type !== 'rendered') return Reflect.apply(original, this, [message, ...rest])
      proto.postMessage = original
      return Reflect.apply(original, this, [{ ...m, svg: '<html/>' }, ...rest])
    }
  })
  await appendToNote(page, `\n\n${SECOND_FLOWCHART}\n`)
  const error = preview(page).locator('.island-error')
  await expect(error).toHaveText('This diagram cannot be drawn.')
  expect(warnings).toContain('W_MERMAID_FAILED svg')

  // A later change does not ask for it again: a diagram added after it draws
  // (requests are answered in order) while the box stays.
  await appendToNote(page, `\nAfter.\n\n${SEQUENCE}\n`)
  await expect(svgs).toHaveCount(2, { timeout: 20_000 })
  await expect(svgs.nth(1)).toContainText('Alice')
  await expect(error).toHaveText('This diagram cannot be drawn.')
})

// A note long enough that the preview renders it in several pieces.
const sections = (count: number, extra: (n: number) => string = () => '') =>
  Array.from(
    { length: count },
    (_, i) =>
      `## Part ${i + 1}\n\n${'A paragraph that fills the piece with words. '.repeat(12)}\n\n${extra(i + 1)}`,
  ).join('\n\n')

test('a task far down a long note still ticks its own line after typing above it', async ({
  page,
}) => {
  await newNote(
    page,
    'Long',
    sections(12, (n) => (n === 11 ? '- [ ] far task\n' : '')),
  )
  await mode(page, 'Split').click()
  const box = preview(page).getByRole('checkbox')
  await expect(box).toHaveCount(1)
  const heading = preview(page).getByRole('heading', { name: 'Part 12' })
  const lineBefore = Number(await heading.getAttribute('data-source-line'))

  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.insertText('Typed first.\n\n')
  await expect(preview(page).locator('p').first()).toHaveText('Typed first.')
  await expect(heading).toHaveAttribute('data-source-line', String(lineBefore + 2))

  await box.click()
  await expect(page.getByRole('textbox', { name: 'Note body' })).toContainText('- [x] far task')
  await expect(box).toBeChecked()
})

test('a diagram is drawn only once it is within a screen of the view, above or below it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 600 })
  await newNote(
    page,
    'Far',
    `${DIAGRAM}\n\n${sections(30)}\n\n${SECOND_FLOWCHART}\n\n${sections(30)}\n\n${SEQUENCE}\n`,
  )
  await mode(page, 'Preview').click()
  const diagrams = preview(page).locator('.island-mermaid')
  const svgs = preview(page).locator('.island-mermaid svg')
  await expect(diagrams.nth(0).locator('svg')).toHaveCount(1, { timeout: 20_000 })
  await page.waitForTimeout(500)
  await expect(svgs).toHaveCount(1)
  // One not drawn yet holds a place, so the note's length changes little as diagrams land.
  expect((await diagrams.nth(1).boundingBox())?.height).toBeGreaterThan(100)

  await preview(page).evaluate((e) => {
    e.scrollTop = e.scrollHeight
  })
  await expect(diagrams.nth(2).locator('svg')).toContainText('Alice', { timeout: 20_000 })
  // The one in the middle is far above the view now: it still waits.
  await page.waitForTimeout(500)
  await expect(diagrams.nth(1).locator('svg')).toHaveCount(0)

  await diagrams.nth(1).scrollIntoViewIfNeeded()
  await expect(diagrams.nth(1).locator('svg')).toContainText('Review', { timeout: 20_000 })
})

const noteBody = (page: Page) => page.getByRole('textbox', { name: 'Note body' })

test('a footnote link scrolls to its footnote, and its back link to the text', async ({ page }) => {
  const filler = Array.from({ length: 60 }, (_, i) => `Line ${i}\n`).join('\n')
  await newNote(page, 'Notes', `Claim.[^1]\n\n${filler}\n[^1]: The source.`)
  await mode(page, 'Preview').click()
  const footnote = preview(page).locator('li[id="user-content-fn-1"]')
  await expect(footnote).toHaveCount(1)
  await expect(footnote).not.toBeInViewport()
  await preview(page).locator('a[data-footnote-ref]').click()
  await expect(footnote).toBeInViewport()
  await preview(page).locator('a[data-footnote-backref]').click()
  await expect(preview(page).locator('a[data-footnote-ref]')).toBeInViewport()
})

test('a link the preview will not open says so and offers its address', async ({ page }) => {
  await newNote(page, 'Mail', 'Write [me](mailto:a@b.example) or see [this](http://example.com).')
  await mode(page, 'Split').click()
  await preview(page).getByRole('link', { name: 'me' }).click()
  const notice = preview(page).getByRole('status')
  await expect(notice).toHaveText('Only https links open from the preview: mailto:a@b.example')
  await preview(page).getByRole('link', { name: 'this' }).click()
  await expect(notice).toHaveText('Only https links open from the preview: http://example.com')
  const opened = await page.evaluate(() =>
    window.devotIpcCalls.filter((c) => c.cmd === 'open_external'),
  )
  expect(opened).toEqual([])
  await preview(page).getByRole('button', { name: 'Dismiss' }).click()
  await expect(notice).toHaveCount(0)
})

test('a details block the reader opened stays open while the note is edited', async ({ page }) => {
  await newNote(page, 'Folds', '<details><summary>More</summary>Hidden text.</details>\n\nTail')
  await mode(page, 'Split').click()
  const details = preview(page).locator('details')
  await details.getByText('More').click()
  await expect(details).toHaveJSProperty('open', true)
  await noteBody(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText(' edited')
  await expect(preview(page)).toContainText('Tail edited')
  await expect(details).toHaveJSProperty('open', true)
})

test('an image with a width and a height keeps the ratio of the picture', async ({ page }) => {
  await page.route('**/test-images/ratio.svg', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="100%" height="100%" fill="teal"/></svg>',
    }),
  )
  await newNote(page, 'Photo', '![photo w:320 h:100](/test-images/ratio.svg)')
  await mode(page, 'Preview').click()
  const image = preview(page).locator('img').first()
  await expect.poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(400)
  const drawn = await image.evaluate((el) => {
    const style = window.getComputedStyle(el)
    const box = el.getBoundingClientRect()
    const across = parseFloat(style['paddingLeft']!) + parseFloat(style['paddingRight']!)
    const down = parseFloat(style['paddingTop']!) + parseFloat(style['paddingBottom']!)
    return (box.width - across) / (box.height - down)
  })
  expect(drawn).toBeCloseTo(4 / 3, 1)
})

test('a block that stops being a diagram does not keep the diagram', async ({ page }) => {
  await newNote(page, 'Swap', `${DIAGRAM}\n\n> [!NOTE]\n> Mind the gap.`)
  await mode(page, 'Split').click()
  await expect(preview(page).locator('.island-mermaid svg')).toHaveCount(1)
  await noteBody(page).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText('> [!NOTE]\n> Mind the gap.')
  await expect(preview(page).locator('[data-devot-island]')).toHaveCount(0)
  await expect(preview(page).locator('.alert')).toContainText('Mind the gap.')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(preview(page).locator('.island-mermaid svg')).toHaveCount(1, { timeout: 20_000 })
  await expect(preview(page).locator('.island-mermaid .alert-title')).toHaveCount(0)
  await expect(preview(page).locator('.alert')).toHaveCount(1)
})

test('a diagram that parses but cannot be laid out is not drawn again at each edit', async ({
  page,
}) => {
  await newNote(page, 'Layout', FLOWCHART)
  await mode(page, 'Split').click()
  await expect(preview(page).locator('.island-mermaid svg')).toHaveCount(1)

  // Mermaid measures with getBBox: a drawing that cannot be measured fails after the source parsed.
  const frame = await mermaidFrame(page)
  await frame.evaluate(() => {
    const w = window
    w.devotMeasured = 0
    w.SVGGraphicsElement.prototype.getBBox = () => {
      w.devotMeasured += 1
      throw new Error('test')
    }
  })
  await appendToNote(page, `\n\n${SECOND_FLOWCHART}\n`)
  await expect(preview(page).locator('.island-error')).toHaveText(
    'This diagram has an error and cannot be drawn.',
    { timeout: 20_000 },
  )
  const measured = () => frame.evaluate(() => window.devotMeasured)
  const before = await measured()
  for (const text of ['\nOne.\n', '\nTwo.\n', '\nThree.\n']) {
    await appendToNote(page, text)
    await expect(preview(page)).toContainText(text.trim())
  }
  await page.waitForTimeout(1500)
  expect(await measured()).toBe(before)
})

test('right-to-left text reads right to left in the preview and the editor', async ({ page }) => {
  await newNote(page, 'Hebrew', 'שלום, עולם!\n\nHello')
  await mode(page, 'Split').click()
  const paragraphs = preview(page).locator('p')
  await expect(paragraphs).toHaveCount(2)
  const bidi = (index: number) =>
    paragraphs.nth(index).evaluate((el) => {
      const style = window.getComputedStyle(el)
      return style['unicodeBidi']
    })
  expect(await bidi(0)).toBe('plaintext')
  const line = page.locator('.cm-line').filter({ hasText: 'שלום' })
  expect(await line.evaluate((el) => window.getComputedStyle(el)['unicodeBidi'])).toBe('plaintext')
})

test('a note link chip follows its note when it changes elsewhere', async ({ page }) => {
  await newNote(page, 'Target')
  await newNote(page, 'Source')
  const target = await page.evaluate(() => {
    const notes = JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as {
      id: string
      title: string
    }[]
    return notes.find((n) => n.title === 'Target')?.id
  })
  await noteBody(page).click()
  await page.keyboard.insertText(`See [](devot://note/${target}).`)
  await mode(page, 'Split').click()
  const chip = preview(page).locator('a.note-chip')
  await expect(chip).toContainText('Target')
  await page.evaluate((id) => {
    const notes = JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as {
      id: string
      title: string
    }[]
    localStorage.setItem(
      'devot.test.notes',
      JSON.stringify(
        notes.map((n) =>
          n.id === id
            ? {
                ...n,
                title: 'Renamed',
                titleHlc: `${String(Date.now() + 60_000).padStart(16, '0')}-0000-mcptest`,
              }
            : n,
        ),
      ),
    )
    const w = window
    w.dispatchEvent(new w.CustomEvent('devot:db-changed'))
  }, target)
  await expect(chip).toContainText('Renamed')
})
