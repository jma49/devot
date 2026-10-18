import type { Page } from '@playwright/test'
import { changeEditorSettingsElsewhere, expect, test, type TestWindow } from './fixtures'

// Synced scrolling: in split mode, scrolling either pane brings the
// other to the same source line. On by default; the palette, the View menu
// (Rust) and Settings > Preview turn it off.

const SECTIONS = 120

/** The DOM these tests touch (this config has no DOM types). */
interface DomNode {
  scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
  readonly clientTop: number
  readonly textContent: string | null
  readonly shadowRoot: {
    querySelector(selector: string): DomNode | null
  } | null
  querySelectorAll(selector: string): ArrayLike<DomNode>
  getBoundingClientRect(): { top: number }
  closest(selector: string): DomNode | null
  querySelector(selector: string): DomNode | null
  addEventListener(type: string, listener: () => void): void
  focus(): void
}
interface PageGlobals {
  document: { querySelector(selector: string): DomNode | null }
  requestAnimationFrame(run: () => void): number
}

/** Sections of different heights in the preview, one source line each part. */
function longNote(): string {
  const parts: string[] = []
  for (let i = 1; i <= SECTIONS; i += 1) {
    parts.push(`## Section ${i}`)
    if (i % 10 === 0) parts.push('```', `code ${i}`, `more code ${i}`, '```')
    else if (i % 3 === 0) parts.push('- a', '- b', '- c')
    else parts.push(`Paragraph ${i}.`)
  }
  return parts.join('\n\n')
}

const preview = (page: Page) => page.getByRole('article', { name: 'Preview' })
const mode = (page: Page, name: 'Edit' | 'Split' | 'Preview') =>
  page.getByRole('group', { name: 'View mode' }).getByRole('button', { name })

async function openLongNote(page: Page) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Title' }).fill('Long')
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.insertText(longNote())
  // Typing left the editor at the end; start at the top.
  await page.keyboard.press('ControlOrMeta+Home')
  await mode(page, 'Split').click()
  await expect(preview(page).getByRole('heading', { name: `Section ${SECTIONS}` })).toBeAttached()
}

/**
 * Scrolls the editor (the element that scrolls it) until the line `text`
 * is at its top, as a user's scrolling would, one step per frame.
 */
async function scrollEditorTo(page: Page, text: string) {
  await page.evaluate(async (wanted) => {
    const win = globalThis as unknown as PageGlobals
    const box = win.document
      .querySelector('[data-devot-part="editor-body"]')!
      .shadowRoot!.querySelector('.editor-scroll')!
    const frame = () => new Promise<void>((done) => win.requestAnimationFrame(() => done()))
    const number = (s: string) => Number(/(\d+)$/.exec(s)?.[1] ?? NaN)
    const target = number(wanted)
    for (let step = 0; step < 60; step += 1) {
      const lines = Array.from(box.querySelectorAll('.cm-line'))
      const line = lines.find((l) => l.textContent === wanted)
      const top = box.getBoundingClientRect().top + box.clientTop
      if (line) {
        const delta = line.getBoundingClientRect().top - top
        if (Math.abs(delta) < 1) return
        box.scrollTop += delta
      } else {
        const shown = lines.map((l) => l.textContent ?? '').find((t) => t.startsWith('## '))
        box.scrollTop += (shown && number(shown) > target ? -0.5 : 0.5) * box.clientHeight
      }
      await frame()
    }
    throw new Error('E_TEST_LINE_NOT_REACHED')
  }, text)
}

/** Scrolls the preview so the heading `name` is at its top. */
async function scrollPreviewTo(page: Page, name: string) {
  await preview(page)
    .getByRole('heading', { name, exact: true })
    .evaluate((heading) => {
      const pane = (heading as unknown as DomNode).closest('.preview')!
      const top = pane.getBoundingClientRect().top + pane.clientTop
      pane.scrollTop += (heading as unknown as DomNode).getBoundingClientRect().top - top
    })
}

/** How far the heading `name` is below the preview's top edge, in pixels. */
function previewOffset(page: Page, name: string) {
  return preview(page)
    .getByRole('heading', { name, exact: true })
    .evaluate((heading) => {
      const pane = (heading as unknown as DomNode).closest('.preview')!
      const top = (heading as unknown as DomNode).getBoundingClientRect().top
      return top - pane.getBoundingClientRect().top - pane.clientTop
    })
}

/** How far the editor line `text` is below the editor's top edge, or null when it is not drawn. */
function editorOffset(page: Page, text: string) {
  return page.evaluate((wanted) => {
    const win = globalThis as unknown as PageGlobals
    const box = win.document
      .querySelector('[data-devot-part="editor-body"]')!
      .shadowRoot!.querySelector('.editor-scroll')!
    const line = Array.from(box.querySelectorAll('.cm-line')).find((l) => l.textContent === wanted)
    if (!line) return null
    return line.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientTop
  }, text)
}

const scrollTops = (page: Page) =>
  page.evaluate(() => {
    const win = globalThis as unknown as PageGlobals
    const box = win.document
      .querySelector('[data-devot-part="editor-body"]')!
      .shadowRoot!.querySelector('.editor-scroll')!
    const pane = win.document.querySelector('.preview')!
    return { editor: box.scrollTop, preview: pane.scrollTop }
  })

const near = (value: number | null) => value !== null && Math.abs(value) <= 3

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('scrolling the editor brings the preview to the same line', async ({ page }) => {
  await openLongNote(page)
  await scrollEditorTo(page, '## Section 40')
  await expect.poll(() => previewOffset(page, 'Section 40').then(near)).toBe(true)
  await scrollEditorTo(page, '## Section 87')
  await expect.poll(() => previewOffset(page, 'Section 87').then(near)).toBe(true)
  await scrollEditorTo(page, '## Section 1')
  await expect.poll(() => previewOffset(page, 'Section 1').then(near)).toBe(true)
  // The very top and the very bottom line up too.
  await page.locator('[data-devot-part="editor-scroll"]').evaluate((box) => (box.scrollTop = 0))
  await expect.poll(async () => (await scrollTops(page)).preview).toBe(0)
  await page
    .locator('[data-devot-part="editor-scroll"]')
    .evaluate((box) => (box.scrollTop = box.scrollHeight))
  await expect
    .poll(() =>
      preview(page).evaluate((pane) => pane.scrollHeight - pane.clientHeight - pane.scrollTop),
    )
    .toBeLessThan(1)
})

test('scrolling the preview brings the editor to the same line', async ({ page }) => {
  await openLongNote(page)
  await scrollPreviewTo(page, 'Section 70')
  await expect.poll(() => editorOffset(page, '## Section 70').then(near)).toBe(true)
  await scrollPreviewTo(page, 'Section 25')
  await expect.poll(() => editorOffset(page, '## Section 25').then(near)).toBe(true)
})

test('a wheel over either pane scrolls both, and the follower never scrolls back', async ({
  page,
}) => {
  await openLongNote(page)
  const editorBox = (await page.locator('[data-devot-part="editor-body"]').boundingBox())!
  await page.mouse.move(editorBox.x + editorBox.width / 2, editorBox.y + editorBox.height / 2)
  await page.mouse.wheel(0, 1500)
  await expect.poll(async () => (await scrollTops(page)).preview).toBeGreaterThan(500)
  // Once both have settled, nothing moves any more: no scroll went back and forth.
  const settled = await page.evaluate(async () => {
    const win = globalThis as unknown as PageGlobals
    const frame = () => new Promise<void>((done) => win.requestAnimationFrame(() => done()))
    const box = win.document
      .querySelector('[data-devot-part="editor-body"]')!
      .shadowRoot!.querySelector('.editor-scroll')!
    const pane = win.document.querySelector('.preview')!
    for (let i = 0; i < 10; i += 1) await frame()
    let events = 0
    const count = () => (events += 1)
    box.addEventListener('scroll', count)
    pane.addEventListener('scroll', count)
    for (let i = 0; i < 20; i += 1) await frame()
    return events
  })
  expect(settled).toBe(0)
  const editorTop = (await scrollTops(page)).editor
  expect(editorTop).toBeGreaterThan(500)

  const previewBox = (await preview(page).boundingBox())!
  await page.mouse.move(previewBox.x + previewBox.width / 2, previewBox.y + previewBox.height / 2)
  await page.mouse.wheel(0, 1500)
  await expect.poll(async () => (await scrollTops(page)).editor).toBeGreaterThan(editorTop + 200)
})

test('wheel steps move the preview in the same event, never back, to the matching block', async ({
  page,
}) => {
  await openLongNote(page)
  const editorBox = (await page.locator('[data-devot-part="editor-body"]').boundingBox())!
  await page.mouse.move(editorBox.x + editorBox.width / 2, editorBox.y + editorBox.height / 2)
  // No waiting between the steps and the reads: each wheel moves both panes itself.
  let last = 0
  for (let step = 0; step < 25; step += 1) {
    await page.mouse.wheel(0, 45)
    const { preview: top } = await scrollTops(page)
    expect(top).toBeGreaterThan(last)
    last = top
  }
  // Bring the next heading in the editor to its top with one more wheel step.
  const next = await page.evaluate(() => {
    const win = globalThis as unknown as PageGlobals
    const box = win.document
      .querySelector('[data-devot-part="editor-body"]')!
      .shadowRoot!.querySelector('.editor-scroll')!
    const top = box.getBoundingClientRect().top + box.clientTop
    for (const line of Array.from(box.querySelectorAll('.cm-line'))) {
      const offset = line.getBoundingClientRect().top - top
      if (offset > 20 && (line.textContent ?? '').startsWith('## ')) {
        return { text: line.textContent!, offset }
      }
    }
    return null
  })
  expect(next).not.toBeNull()
  await page.mouse.wheel(0, next!.offset)
  await expect.poll(() => editorOffset(page, next!.text).then(near)).toBe(true)
  await expect.poll(() => previewOffset(page, next!.text.slice(3)).then(near)).toBe(true)
})

test('the preview keeps up while typing above what it shows', async ({ page }) => {
  await openLongNote(page)
  await scrollEditorTo(page, '## Section 60')
  await expect.poll(() => previewOffset(page, 'Section 60').then(near)).toBe(true)
  // A paragraph typed at the top of the editor's view, not at the top of the
  // note: the preview, rendered anew with a block above what it shows, must
  // line up with the editor again.
  await page.getByRole('textbox', { name: 'Note body' }).getByText('## Section 60').click()
  await page.keyboard.press('Home')
  await page.keyboard.insertText('Inserted paragraph\n\n')
  const inserted = preview(page).getByText('Inserted paragraph', {
    exact: true,
  })
  await expect(inserted).toBeAttached()
  // The new paragraph sits as far below the top in the preview as in the editor.
  await expect
    .poll(async () => {
      const inEditor = await editorOffset(page, 'Inserted paragraph')
      const inPreview = await inserted.evaluate((block) => {
        const pane = (block as unknown as DomNode).closest('.preview')!
        const top = (block as unknown as DomNode).getBoundingClientRect().top
        return top - pane.getBoundingClientRect().top - pane.clientTop
      })
      return inEditor !== null && Math.abs(inEditor) < 50 && near(inPreview - inEditor)
    })
    .toBe(true)
  expect((await scrollTops(page)).preview).toBeGreaterThan(500)
})

test('is on by default and turned off and on from the palette', async ({ page }) => {
  await openLongNote(page)
  await page.keyboard.press('Meta+KeyK')
  const field = page.getByRole('combobox', { name: 'Command Palette' })
  await field.fill('synced scrolling')
  await expect(page.getByRole('option', { name: /Turn Off Synced Scrolling/ })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect
    .poll(() =>
      page.evaluate(() =>
        (globalThis as unknown as TestWindow).devotIpcCalls
          .filter((c) => c.cmd === 'editor_settings_set')
          .map((c) => c.args['patch']),
      ),
    )
    .toEqual([{ syncScroll: false }])

  // The preview stays where it is (the top of its first block, at most).
  const still = (await scrollTops(page)).preview
  await scrollEditorTo(page, '## Section 50')
  await page.waitForTimeout(200)
  expect((await scrollTops(page)).preview).toBe(still)
  await scrollPreviewTo(page, 'Section 30')
  await page.waitForTimeout(200)
  expect(await editorOffset(page, '## Section 50').then(near)).toBe(true)

  await page.keyboard.press('Meta+KeyK')
  await field.fill('synced scrolling')
  await expect(page.getByRole('option', { name: /Turn On Synced Scrolling/ })).toBeVisible()
  await page.keyboard.press('Enter')
  // Turned on, the preview lines up with the editor at once.
  await expect.poll(() => previewOffset(page, 'Section 50').then(near)).toBe(true)
})

test('follows the setting changed elsewhere (View > Synced Scrolling, Settings)', async ({
  page,
}) => {
  await openLongNote(page)
  await changeEditorSettingsElsewhere(page, { syncScroll: false })
  // The preview stays where it is (the top of its first block, at most).
  const still = (await scrollTops(page)).preview
  await scrollEditorTo(page, '## Section 45')
  await page.waitForTimeout(200)
  expect((await scrollTops(page)).preview).toBe(still)
  await changeEditorSettingsElsewhere(page, { syncScroll: true })
  await expect.poll(() => previewOffset(page, 'Section 45').then(near)).toBe(true)
})

test('applies only in split mode, and keeps the place read in Preview', async ({ page }) => {
  await openLongNote(page)
  await mode(page, 'Preview').click()
  await scrollPreviewTo(page, 'Section 90')
  await mode(page, 'Split').click()
  // The preview keeps the place being read; the editor comes to it.
  await expect.poll(() => editorOffset(page, '## Section 90').then(near)).toBe(true)
  expect(await previewOffset(page, 'Section 90').then(near)).toBe(true)
})

test('a diagram drawn after the rendering does not leave the preview behind', async ({ page }) => {
  // The diagram library arrives late, after the preview has lined up.
  await page.route(/\/mermaid\.html/, async (route) => {
    await new Promise((done) => setTimeout(done, 1500))
    await route.continue()
  })
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Title' }).fill('Diagram')
  await page.getByRole('textbox', { name: 'Note body' }).click()
  const diagram = ['```mermaid', 'graph TD', '  A --> B', '  B --> C', '  C --> D', '```'].join(
    '\n',
  )
  await page.keyboard.insertText(diagram + '\n\n' + longNote())
  // Without the browser's scroll anchoring, which would hide a missed relayout.
  await page.addStyleTag({ content: '.preview { overflow-anchor: none; }' })
  // In the editor alone, go to a section below the diagram, then show both.
  await scrollEditorTo(page, '## Section 60')
  await mode(page, 'Split').click()
  await expect(preview(page).locator('.island-mermaid svg')).toBeAttached()
  await expect.poll(() => previewOffset(page, 'Section 60').then(near)).toBe(true)
})
